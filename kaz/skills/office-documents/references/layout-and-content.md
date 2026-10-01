# Layout and content, format by format

The rules that apply to every format are in the main `SKILL.md`. What follows is the same discipline
seen from inside one container: what the format lets you do, and the mistakes it makes easy.

## Layout rules that apply to all four formats

Use one type scale and one spacing scale, exactly as for an interface: a heading, a body, and a
small; multiples of one spacing unit; one accent color. The differences are in what each format lets
you do.

- **Use named styles**, not per-paragraph formatting. Named styles keep a document consistent and
  let the reader restyle it; direct formatting on every paragraph is the document equivalent of
  inline CSS on every element.
- **Let content drive layout.** Never hard-code a cell reference, a page number, or a slide count
  that a different data set would invalidate. Build tables cell by cell from the data.
- **Keep the reader's units.** Dates, times, percentages, and currency are cell or field *values*
  with a display format - never pre-formatted strings. A spreadsheet full of text is not a
  spreadsheet.
- **Numbers align right, text left, headers bold with a subtle fill.** One header row style, one body
  style, and a frozen pane when the table scrolls.
- **Column widths fit the content**: width by the longest realistic value, not by the sample.
- **Colour carries meaning or nothing.** Highlight the exception, not every other row.
- **Prefer native chart objects** over embedded images, so the reader can edit them.

## Word documents

- One idea per paragraph; headings from `Heading 1`/`Heading 2`, body from the document's base style
  rather than a font set per paragraph.
- Tables for tabular data; a real page break rather than many empty paragraphs; a section for a
  landscape page.
- Check line spacing and space-after- rather than inserting blank paragraphs between blocks.
- Fill an existing template when one exists: it carries the styles, headers, and footers the
  organisation expects.

## Spreadsheets

- One table per sheet, header row first, no merged cells inside the data range.
- Restate the important rule: **typed values plus a number format** - `0.075` displayed as `7.5%`, a
  date as a date. Text that looks like a number breaks sorting, totals, and filters.
- Freeze the header row; add an autofilter when the reader will sort; name the sheet for its content.
- Summaries go above or on their own sheet - not appended below the data where they become a data
  row.
- A formula is better than a pasted constant when the value is derived: the reader can see and check
  the derivation.

## Slides

- The headline states the point ("Latency halved after the cache change"), not the topic ("Latency").
- One idea per slide, and a slide that needs a paragraph is two slides or a document.
- Keep to the layout's placeholders so the deck stays consistent, and keep text inside the safe
  margins; set the slide size explicitly (16:9) rather than inheriting an old default.
- Assume fonts differ on the reader's machine: choose widely available families, and treat exact
  rendering as unverified unless you have rendered it.

## Where this reference stops

Choosing a container and installing the library that fits it is in `format-and-setup.md`; the checks
to run on the finished file are in `verify-by-reading-back.md`; the layout rules every format shares
are in the main `SKILL.md`.

Read this file in windows if the file-read tool reports it was trimmed: a tool result over 8192 code
points loses its middle the next time compaction runs. Below 200 lines it is read whole.
