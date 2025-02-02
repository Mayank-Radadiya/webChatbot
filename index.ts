import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import { ChromaClient } from "chromadb";

dotenv.config();

const chromaClient = new ChromaClient({ path: "http://localhost:8000" });
chromaClient.heartbeat();

const WebCollection = `WEB_SCRAPED_DATA_COLLECTION-1`;
interface insertIntoDbProps {
  embedding: number[];
  url: string;
  body: string;
  head: string;
}
async function insertIntoDb({
  embedding,
  url,
  body = "",
  head,
}: insertIntoDbProps) {
  const collection = await chromaClient.getOrCreateCollection({
    name: WebCollection,
  });

  await collection.add({
    ids: [url],
    embeddings: [embedding],
    metadatas: [{ url, body, head }],
  });
}

async function scapeWebpage(url: string): Promise<{
  head: string;
  body: string;
  externalLinks: string[];
  internalLinks: string[];
} | null> {
  // Get url of webpage
  if (!url) {
    console.log("Please provide a URL");
    return null;
  }

  const { data } = await axios.get(url); // Send request to the url and get HTMl data

  const $ = cheerio.load(data); // Load the HTML data into cheerio

  const head = $("head").html() || ""; // extract head tag
  const body = $("body").html() || ""; // extract body tag

  // const externalLinks: string[] = []; // Array to store external links
  // const internalLinks: string[] = []; // Array to store internal links

  const externalLinks = new Set<string>(); // Array to store external links
  const internalLinks = new Set<string>();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (href === "/") return;
    if (href?.startsWith("http") || href?.startsWith("http")) {
      externalLinks.add(href);
    } else {
      internalLinks.add(href);
    }
  });

  return {
    head,
    body,
    externalLinks: Array.from(externalLinks),
    internalLinks: Array.from(internalLinks),
  };
}

interface EmbeddingProps {
  text: string;
}
async function generateEmbeddings({ text }: EmbeddingProps) {
  if (!process.env.GEMINI_API_KEY) {
    return console.log(" GEMINI_API_KEY is required");
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

  const embedding = await model.embedContent(text);
  return embedding.embedding.values;
}

// This function formats the text into chunks of a specified size
// when we get huge body html test. Ai can't generate embeddings for huge text.
// So we need to split the text into chunks for specific characters
function chunkText(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) throw new Error("Chunk size must be greater than 0");

  const chunks: string[] = [];
  let currentChunk = "";
  let words = text.split(" "); // Split text into words to maintain readability

  for (const word of words) {
    if ((currentChunk + word).length <= chunkSize) {
      currentChunk += (currentChunk ? " " : "") + word;
    } else {
      chunks.push(currentChunk);
      currentChunk = word;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

async function ingest(url: string) {
  console.log(`😈 Ingesting ${url}`);

  const result = await scapeWebpage(url);
  if (!result) {
    console.log("Failed to scrape webpage");
    return;
  }

  const { head, body, internalLinks } = result;

  const headEmbeddings = await generateEmbeddings({ text: head });
  if (!headEmbeddings) {
    console.log("Failed to generate embeddings for head");
    return;
  }
  await insertIntoDb({ embedding: headEmbeddings, url, head, body });

  const bodyChunks = chunkText(body, 1000); // Split body into chunks of 1000 characters

  for (const chunk of bodyChunks) {
    const bodyEmbeddings = await generateEmbeddings({ text: chunk });
    if (!bodyEmbeddings) {
      console.log("Failed to generate embeddings for body");
      return;
    }
    await insertIntoDb({ embedding: bodyEmbeddings, url, head, body: chunk });
  }

  // for (const link of internalLinks) {
  //   const _url = `${url}${link}`;
  //   await ingest(_url);
  // }

  console.log(`🎉 Ingested success ${url}`);
}

async function chat(question: string) {
  const questionEmbedding = await generateEmbeddings({ text: question });
  if (!questionEmbedding) {
    console.log("Failed to generate embeddings for question");
    return;
  }

  const collection = await chromaClient.getOrCreateCollection({
    name: WebCollection,
  });
  const collectionResult = await collection.query({
    nResults: 1,
    queryEmbeddings: questionEmbedding,
  });

  const body = collectionResult.metadatas[0]
    .map((meta: any) => meta.body)
    .filter((e) => e.trim() !== "" && !!e);

  const url = collectionResult.metadatas[0]
    .map((meta: any) => meta.url)
    .filter((e) => e.trim() !== "" && !!e);

  if (!process.env.GEMINI_API_KEY) {
    return console.log(" GEMINI_API_KEY is required");
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const response = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Answer the following question based on the context provided:\n\nContext: ${body.join(
              ", "
            )}
            Url: ${url.join(", ")}
            )}\n\nQuestion: ${question}`,
          },
        ],
      },
    ],
  });

  if (!response || !response.response.text()) {
    console.log("Failed to generate a response from Gemini AI.");
    return;
  }

  console.log( "🥲",response.response.text());
  
  return response.response.text();
}
