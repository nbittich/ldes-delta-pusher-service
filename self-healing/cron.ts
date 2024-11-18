import { querySudo } from "@lblod/mu-auth-sudo";
import { CronJob } from "cron";
import { text } from "node:stream/consumers";
import { healEntities } from "./heal-ldes-data";
import {
  clearHealingTempGraphs,
  insertLdesPageToDumpGraph,
} from "./upload-entities-to-db";
import { transformLdesDataToEntities } from "./transform-ldes-data-to-entities";
import { CRON_HEALING } from "../config";
import { HealingConfig, getHealingConfig } from "../config/healing";
import {
  ttlFileAsContentType,
  ttlFileAsString,
} from "../util/ttlFileAsContentType";

import { getNode, getConfigFromEnv } from "@lblod/ldes-producer";
const ldesProducerConfig = getConfigFromEnv();

let isRunning = false;
const cronMethod = async () => {
  console.log(
    "*******************************************************************"
  );
  console.log(
    `*** Pull LDES triggered by cron job at ${new Date().toISOString()} ***`
  );
  console.log(
    "*******************************************************************"
  );

  if (isRunning) {
    return;
  }
  isRunning = true;
  const config = await getHealingConfig();
  console.log(`Healing config: ${JSON.stringify(config)}`);

  for (const stream of Object.keys(config)) {
    await healStream(stream, config);
  }
  isRunning = false;
};

async function healStream(stream: string, config: HealingConfig) {
  const startTime = performance.now();

  await clearHealingTempGraphs();
  await loadStreamIntoDumpGraph(stream);
  console.log(
    `Loading LDES into dump graph took ${performance.now() - startTime} ms`
  );
  await transformLdesDataToEntities();
  await healEntities(stream, config);
  console.log(`Healing the LDES took ${performance.now() - startTime} ms`);
}

async function loadStreamIntoDumpGraph(stream: string): Promise<void> {
  let isLdesInsertedInDatabase = false;
  let currentPage: string | null = await determineFirstPageOrCheckpoint(stream);
  while (!isLdesInsertedInDatabase && currentPage) {
    const turtleText = await fetchPage(stream, currentPage);
    if (turtleText) {
      await insertLdesPageToDumpGraph(turtleText);
    } else {
      isLdesInsertedInDatabase = true;
    }
    currentPage = await determineNextPage(currentPage, stream);
  }
}

async function fetchPage(stream: string, page: number): Promise<string | null> {
  console.log(`Loading LDES page ${page}`);
  try {
    const response = await getNode(ldesProducerConfig, {
      folder: stream,
      contentType: "text/turtle",
      nodeId: page,
    });
    return await text(response.stream);
  } catch (e) {
    if (e.status === 404) {
      console.log(
        `Page ${page} not found, assuming it's the last page of the stream`
      );
      return null;
    }
    throw new Error(
      `Failed to fetch LDES page from stream ${stream}, error: ${e}`
    );
  }
}
async function determineFirstPageOrCheckpoint(stream: string): Promise<string> {
  console.log(`Fetching checkpoints for stream ${stream}`);
  const fileString = await ttlFileAsString(
    `/data/${stream}/checkpoints.ttl`,
    "application/ld+json"
  );
  try {
    console.log(`Fetching checkpoints for stream ${stream}`);
    const fileString = await ttlFileAsString(
      `/data/${stream}/checkpoints.ttl`,
      "application/ld+json",
      LDES_ENDPOINT
    );
    const modified = "http://purl.org/dc/terms/modified";
    const twoDaysAgo = new Date().getTime() - 1000 * 60 * 60 * 48;
    // only keep checkpoints that are older than two days so we are
    // reasonably sure the healing has taken effect in the main stream
    const checkpoints = JSON.parse(fileString).filter((i) => {
      return (
        i[modified] && new Date(i[modified][0].value).getTime() < twoDaysAgo
      );
    });
    checkpoints.sort((a: any, b: any) =>
      a[modified][0].value < b[modified][0].value ? 1 : -1
    );
    const checkpointName = checkpoints[0]["@id"].split("checkpoints/")[1];
    return `${stream}/checkpoints/${checkpointName}`;
  } catch (e) {
    return `${stream}/1`;
  }
}

async function determineNextPage(
  currentPage: string,
  stream: string
): Promise<string | null> {
  const relativePageUrl = currentPage.split(`${stream}/`)[1];
  const query = `
    SELECT ?page WHERE {
      ?oldPage <https://w3id.org/tree#relation> ?relation .
      ?relation a <https://w3id.org/tree#GreaterThanOrEqualToRelation> .
      ?relation <https://w3id.org/tree#value> ?date .
      ?relation <https://w3id.org/tree#node> ?page .
      FILTER(STRENDS(STR(?oldPage), "${relativePageUrl}"))
    } LIMIT 1
  `;
  const result = await querySudo(query);
  console.log(
    `Next page query result: ${JSON.stringify(
      result.results.bindings[0]?.page?.value
    )}`
  );
  if (result.results.bindings.length === 0) {
    return null;
  }
  const page = result.results.bindings[0].page.value;
  const safePartOfPageUrl = page.split(`/${stream}/`)[1];
  return `${stream}/${safePartOfPageUrl}`;
}

export const cronjob = CronJob.from({
  cronTime: CRON_HEALING,
  onTick: cronMethod,
});
