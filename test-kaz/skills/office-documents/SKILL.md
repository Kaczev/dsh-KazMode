---
name: office-documents
description: Use when producing a file someone will open in Word, Excel, PowerPoint, or a PDF reader - reports, spreadsheets, decks, invoices, exports - to pick the right library, install it on demand, lay the document out properly, and confirm the file actually opens with the content intended.
user-invocable: false
---

# Office documents

A document is not finished when the script exits successfully. It is finished when you have opened the
generated file with a reader and seen the content arrive where you meant it. Everything else here
serves that.

## Choose the format before the library

| Output | Preferred library | Choose it because |
|---|---|---|
| `.docx` | `python-docx` | paragraphs, runs, real paragraph and character styles, tables, sections |
| `.docx` needing exact control | raw OOXML in a ZIP, or an existing template filled in | headers, footers, fields, and numbering are not all exposed by the high-level API |
| `.xlsx` | `openpyxl` | cells, number formats, styles, native charts, formulas |
| `.pptx` | `python-pptx` | slides, layouts, placeholders, shapes, notes |
| `.pdf` | `reportlab` for generated reports; a headless converter when fidelity must match a Word or HTML source | different tools for different jobs - a PDF that must look like a Word document is a conversion task, not a layout task |

Editing beats regenerating: when the file already exists, open it and change what differs. Rebuilding
a document that carried manual edits destroys them.

## Set up on demand, in the project, not the system

Assume nothing about the machine. Detect, install what is missing, then re-check.

```sh
python -c "import openpyxl, docx"            # probe what exists
python -c "import pptx"                      # a missing one raises ImportError
python -m pip install --user openpyxl python-docx python-pptx reportlab
python -c "import docx, openpyxl; print(docx.__version__, openpyxl.__version__)"
```

- Prefer a project-local virtual environment when the work belongs to a repository; prefer
  `--user` for a one-off. Do not install into a system interpreter when either option exists.
- Install only the libraries the current format needs.
- When an install fails, say which library and which error - do not fall back to hand-writing an
  approximation of the binary format and presenting it as the document.
- A machine without the runtime or without network access is a limitation to report, not something to
  work around silently.

### Pin a floor, then detect - never trust memory

These libraries change their API between minor versions, and a guide's example is written against
whichever version its author had. Treat any version number as a **floor that is known to work**, not
as what is installed here, and let the runtime report the truth:

| Library | Known-good floor |
|---|---|
| Python | 3.9 |
| `python-docx` | 1.0 |
| `openpyxl` | 3.1 |
| `python-pptx` | 0.6.21 |
| `reportlab` | 4.0 |

The floor matters because the APIs genuinely moved. `python-docx` is the cautionary example: before
1.0 the namespace was flat (`docx.Document`), and from 1.0 the package exposes a differently arranged
public API (`from docx import Document`). Code copied from an older example fails on a newer install,
and code written against 1.x fails on 0.8 - which means the only safe move is to ask the installed
version which layout it has and write against that.

Do it in this order:

1. **Probe**: print the installed version of the library you are about to use.
2. **Smoke-test before generating anything real**: write one minimal artifact with that library, save
   it, reopen it, assert one property. This catches an API drift in seconds, before it is buried in a
   hundred lines of document code.

```python
from docx import Document            # python-docx 1.x layout
doc = Document(); doc.add_heading("t", level=1); doc.add_paragraph("b"); doc.save("smoke.docx")
back = Document("smoke.docx")
assert [p.style.name for p in back.paragraphs] == ["Heading 1", "Normal"]
```

3. **Prefer what the runtime shows over what you remember**: when an attribute is missing, list the
   module's own contents (`dir(obj)`) or read the installed package's documentation, rather than
   recalling an older signature. The library on disk is the authority.
4. **Record the version in the report** for anything the reader will rerun, so a future failure can be
   traced to a dependency change instead of to the document logic.

## Layout rules that apply to all four formats

Use one type scale and one spacing scale, exactly as for an interface: a heading, a body, and a small;
multiples of one spacing unit; one accent color. The differences are in what each format lets you do.

- **Use named styles**, not per-paragraph formatting. Named styles keep a document consistent and let
  the reader restyle it; direct formatting on every paragraph is the document equivalent of inline
  CSS on every element.
- **Let content drive layout.** Never hard-code a cell reference, a page number, or a slide count that
  a different data set would invalidate. Build tables cell by cell from the data.
- **Keep the reader's units.** Dates, times, percentages, and currency are cell or field *values* with
  a display format - never pre-formatted strings. A spreadsheet full of text is not a spreadsheet.
- **Numbers align right, text left, headers bold with a subtle fill.** One header row style, one
  body style, and a frozen pane when the table scrolls.
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
- Restate the important rule: **typed values plus a number format** - `0.075` displayed as `7.5%`,
  a date as a date. Text that looks like a number breaks sorting, totals, and filters.
- Freeze the header row; add an autofilter when the reader will sort; name the sheet for its content.
- Summaries go above or on their own sheet - not appended below the data where they become a data row.
- A formula is better than a pasted constant when the value is derived: the reader can see and check
  the derivation.

## Slides

- The headline states the point ("Latency halved after the cache change"), not the topic ("Latency").
- One idea per slide, and a slide that needs a paragraph is two slides or a document.
- Keep to the layout's placeholders so the deck stays consistent, and keep text inside the safe
  margins; set the slide size explicitly (16:9) rather than inheriting an old default.
- Assume fonts differ on the reader's machine: choose widely available families, and treat exact
  rendering as unverified unless you have rendered it.

## Verify by reading the file back

Exit code zero proves the script ran, not that the document is right. Reopen the output with a reader
and check the content:

```python
import openpyxl
wb = openpyxl.load_workbook("out.xlsx")
ws = wb.active
assert ws["B2"].value == expected_value
assert ws["B2"].number_format == "0.0%"
```

- `.docx`: reopen and walk the paragraphs and tables, asserting the text and the style names.
- `.xlsx`: reopen and assert specific cell values **and number formats**, not just that the file loads.
- `.pptx`: reopen and assert the slide count and each slide's title and body text.
- `.pdf`: reopen and extract text, and check the page count.
- Convert to PDF or images and look at it when a rendering step exists - for a layout, that is the only
  acceptance test worth trusting.
- `.docx`, `.xlsx`, and `.pptx` are ZIP archives: when a library will not report something, the parts
  can be inspected directly.

Finish by opening the file in a real application when you can, and say plainly which checks you ran
and which you could not.
