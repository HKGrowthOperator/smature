// Projekte = Themenordner/Geschäftsbereiche (z. B. Webseite, Software Sales App …). Produkte, Zielgruppen, Listen,
// Plays und Firmen gehören zu einem Projekt; daraus entsteht das Board mit einer Spalte pro Projekt.
import { q } from "../db.js";
import { fail } from "../http.js";

// Optionale Projekt-ID aus einem Formular prüfen (leer → kein Projekt).
export function projectId(value) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || !q.get("SELECT 1 FROM projects WHERE id = ?", id)) fail(400, "Projekt nicht gefunden");
  return id;
}

export function listProjects() {
  return q.all("SELECT * FROM projects ORDER BY position, id");
}
