import { withRequestDatabase } from "../lib/database";
import { operationsDb } from "../lib/operations/schema";
import { repairKnowledgeChunkEmbeddings } from "../lib/operations/rag";

const forceAll = process.argv.includes("--force");

await withRequestDatabase(async () => {
  const db = await operationsDb();
  const beforeModels = await db
    .prepare(
      "SELECT COALESCE(embedding_model, '') AS model, COUNT(*)::int AS count FROM support_knowledge_chunks GROUP BY COALESCE(embedding_model, '') ORDER BY count DESC",
    )
    .all<{ model: string; count: number }>();

  console.log("[reembed:rag] Before repair:", beforeModels.results);

  const result = await repairKnowledgeChunkEmbeddings({
    forceAll,
    actorId: "cli_reembed",
  });

  const afterModels = await db
    .prepare(
      "SELECT COALESCE(embedding_model, '') AS model, COUNT(*)::int AS count FROM support_knowledge_chunks GROUP BY COALESCE(embedding_model, '') ORDER BY count DESC",
    )
    .all<{ model: string; count: number }>();

  console.log("[reembed:rag] Repair result:", result);
  console.log("[reembed:rag] After repair:", afterModels.results);
  await db.close();
}, 300000);
