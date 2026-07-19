# Modo: apply — Asistente de Aplicación en Vivo

Modo interactivo para cuando el candidato está rellenando un formulario de aplicación en Chrome. Lee lo que hay en pantalla, carga el contexto previo de la oferta, y genera respuestas personalizadas para cada pregunta del formulario.

## Requisitos

- **Mejor con Playwright visible**: En modo visible, el candidato ve el navegador y Claude puede interactuar con la página.
- **Sin Playwright**: el candidato comparte un screenshot o pega las preguntas manualmente.

## Workflow

```
1. DETECTAR    → Leer Chrome tab activa (screenshot/URL/título)
2. IDENTIFICAR → Extraer empresa + rol de la página
3. BUSCAR      → Match contra reports existentes en reports/
4. CARGAR      → Leer report completo + Section G (si existe)
5. COMPARAR    → ¿El rol en pantalla coincide con el evaluado? Si cambió → avisar
6. ANALIZAR    → Identificar TODAS las preguntas del formulario visibles
7. GENERAR     → Para cada pregunta, generar respuesta personalizada
8. PRESENTAR   → Mostrar respuestas formateadas para copy-paste
```

## Paso 1 — Detectar la oferta

**Con Playwright:** Tomar snapshot de la página activa. Leer título, URL, y contenido visible.

**Sin Playwright:** Pedir al candidato que:
- Comparta un screenshot del formulario (Read tool lee imágenes)
- O pegue las preguntas del formulario como texto
- O diga empresa + rol para que lo busquemos

## Paso 2 — Identificar y buscar contexto

1. Extraer nombre de empresa y título del rol de la página
2. Buscar en `reports/` por nombre de empresa (Grep case-insensitive)
3. Si hay match → cargar el report completo
4. Si hay Section G → cargar los draft answers previos como base
5. Si NO hay match → check `data/triage-scores.tsv` for the URL:
   - **If triaged with verdict APPLY/APPLY HIGH/APPLY (reach):** generate the full A–G report on-the-fly NOW (run `oferta` mode logic against the URL, write to `reports/{###}-{company-slug}-{date}.md`, add row to `applications.md` with status=Evaluated). Then continue with apply flow using the freshly generated report. Tell the user: "No full report yet for this posting (triage-only). Generating now…"
   - **If triaged with verdict SKIP or SUSPICIOUS:** stop and tell the user the triage flagged this as not worth applying to. Ask if they want to override (forces full evaluation anyway).
   - **If not in triage-scores.tsv either:** offer to run auto-pipeline.

## Paso 3 — Detectar cambios en el rol

Si el rol en pantalla difiere del evaluado:
- **Avisar al candidato**: "El rol ha cambiado de [X] a [Y]. ¿Quieres que re-evalúe o adapto las respuestas al nuevo título?"
- **Si adaptar**: Ajustar las respuestas al nuevo rol sin re-evaluar
- **Si re-evaluar**: Ejecutar evaluación A-F completa, actualizar report, regenerar Section G
- **Actualizar tracker**: Cambiar título del rol en applications.md si procede

## Paso 4 — Analizar preguntas del formulario

Identificar TODAS las preguntas visibles:
- Campos de texto libre (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Campos de salario (range, expectation)
- Upload fields (resume, cover letter PDF)

Clasificar cada pregunta:
- **Ya respondida en Section G** → adaptar la respuesta existente
- **Nueva pregunta** → generar respuesta desde el report + cv.md

## Paso 5 — Generar respuestas

Para cada pregunta, generar la respuesta siguiendo:

1. **Contexto del report**: Usar proof points del bloque B, historias STAR del bloque F
2. **Section G previa**: Si existe una respuesta draft, usarla como base y refinar
3. **Tono "I'm choosing you"**: Mismo framework del auto-pipeline
4. **Especificidad**: Referenciar algo concreto del JD visible en pantalla
5. **get-the-job proof point**: Incluir en "Additional info" si hay campo para ello

**Formato de output:**

```
## Respuestas para [Empresa] — [Rol]

Basado en: Report #NNN | Score: X.X/5 | Arquetipo: [tipo]

---

### 1. [Pregunta exacta del formulario]
> [Respuesta lista para copy-paste]

### 2. [Siguiente pregunta]
> [Respuesta]

...

---

Notas:
- [Cualquier observación sobre el rol, cambios, etc.]
- [Sugerencias de personalización que el candidato debería revisar]
```

## Paso 5b — Generate tailored CV + cover letter (ON-DEMAND, this is the ONLY place they're generated)

Auto-pipeline and batch evaluators do NOT generate PDFs anymore — they only produce the markdown report. PDFs are generated here, when the user is actually applying, to avoid token waste on roles the user never pursues.

When entering apply mode, check `output/cv-adrian-{company-slug}-{date}.pdf`:
- **Exists already?** Skip generation, attach the existing PDF.
- **Doesn't exist?** Generate it now using `modes/pdf.md` (read JD from saved report → tailored summary + competencies + bullets → render via `templates/cv-template.html` + `generate-pdf.mjs`).

Cover letter (`output/cover-adrian-{company-slug}-{date}.pdf`):
- **Generate ONLY if** the application form has a cover-letter upload field, OR the user explicitly asks for one ("write me a cover letter for X").
- 1 page max, same visual design as CV (Space Grotesk + DM Sans + cyan→purple gradient).
- 3-4 paragraphs: hook with JD-quote + match (architectural pattern), honest gap acknowledgment + bridge, why this company specifically.

After generation, update the tracker row's PDF column from `❌` → `✅`.

## Paso 6 — Post-apply (opcional)

Si el candidato confirma que envió la aplicación:
1. Actualizar estado en `applications.md` de "Evaluada" a "Applied"
2. Actualizar Section G del report con las respuestas finales
3. **Remove the URL from `data/triage-scores.tsv`** — once applied, it should not appear in future find-jobs queues:
   ```bash
   awk -F'\t' -v url="$URL" 'NR==1 || $1 != url' data/triage-scores.tsv > data/triage-scores.tsv.tmp \
     && mv data/triage-scores.tsv.tmp data/triage-scores.tsv
   ```
4. Sugerir siguiente paso: `/get-the-job contacto` para LinkedIn outreach

## Scroll handling

Si el formulario tiene más preguntas que las visibles:
- Pedir al candidato que haga scroll y comparta otro screenshot
- O que pegue las preguntas restantes
- Procesar en iteraciones hasta cubrir todo el formulario
