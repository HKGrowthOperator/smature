// Gemeinsame Routen für Wissens-Dokumente (Info-Blätter) von Zielgruppen und Produkten.
import { q, insert, update } from "../db.js";
import { fail, v } from "../http.js";
import { htmlToText } from "../lib/text.js";

const MAX_PDF = 20 * 1024 * 1024;

export function listDocs(column, id) {
  return q.all(`SELECT id, title, kind, file_name, mime, size, created_at, LENGTH(content) AS chars FROM knowledge_docs WHERE ${column} = ? ORDER BY id`, id);
}

// base: z. B. "/api/products", table: "products", column: "product_id"
export function registerDocRoutes(r, { base, table, column, label }) {
  const owner = id => q.get(`SELECT id FROM ${table} WHERE id = ?`, id) || fail(404, `${label} nicht gefunden`);
  const touch = id => q.run(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, Date.now(), id);

  r.post(`${base}/:id/docs`, ({ params, body }) => {
    const id = v.id(params.id);
    owner(id);
    const kind = v.oneOf(body.kind, ["text", "pdf", "html"], "text");
    const title = v.str(body.title || body.file_name, { max: 200, required: true, name: "Titel" });
    const now = Date.now();
    if (kind === "pdf") {
      const data = Buffer.from(String(body.data || ""), "base64");
      if (!data.length) fail(400, "PDF-Daten fehlen");
      if (data.length > MAX_PDF) fail(413, "PDF ist größer als 20 MB");
      if (data.subarray(0, 5).toString("latin1") !== "%PDF-") fail(400, "Datei ist kein PDF");
      const docId = insert("knowledge_docs", { [column]: id, title, kind: "pdf", content: v.text(body.content ?? "", { max: 500000 }), file_name: v.str(body.file_name, { max: 200 }), mime: "application/pdf", size: data.length, data, created_at: now });
      touch(id);
      return { id: docId };
    }
    let content = v.text(body.content, { max: 2000000, name: "Inhalt" });
    if (kind === "html") content = htmlToText(content);
    if (!content.trim()) fail(400, "Inhalt ist leer");
    const docId = insert("knowledge_docs", { [column]: id, title, kind: "text", content, file_name: v.str(body.file_name, { max: 200 }) || null, mime: "text/plain", size: Buffer.byteLength(content), created_at: now });
    touch(id);
    return { id: docId };
  });

  r.get(`${base}/:id/docs/:docId`, ({ params, raw }) => {
    const doc = q.get(`SELECT * FROM knowledge_docs WHERE id = ? AND ${column} = ?`, v.id(params.docId), v.id(params.id)) || fail(404, "Dokument nicht gefunden");
    if (doc.kind === "pdf") {
      const name = String(doc.file_name || "dokument.pdf").replace(/[^\w.\- äöüÄÖÜß]/g, "_");
      return raw({ type: "application/pdf", body: Buffer.from(doc.data), headers: { "Content-Disposition": `attachment; filename="${name}"` } });
    }
    return { id: doc.id, title: doc.title, kind: doc.kind, content: doc.content, created_at: doc.created_at };
  });

  r.put(`${base}/:id/docs/:docId`, ({ params, body }) => {
    const doc = q.get(`SELECT * FROM knowledge_docs WHERE id = ? AND ${column} = ?`, v.id(params.docId), v.id(params.id)) || fail(404, "Dokument nicht gefunden");
    const row = { title: v.str(body.title ?? doc.title, { max: 200, required: true, name: "Titel" }) };
    if (doc.kind === "text" && body.content !== undefined) { row.content = v.text(body.content, { max: 2000000 }); row.size = Buffer.byteLength(row.content); }
    update("knowledge_docs", doc.id, row);
    return { ok: true };
  });

  r.delete(`${base}/:id/docs/:docId`, ({ params }) => {
    q.run(`DELETE FROM knowledge_docs WHERE id = ? AND ${column} = ?`, v.id(params.docId), v.id(params.id));
    return { ok: true };
  });
}
