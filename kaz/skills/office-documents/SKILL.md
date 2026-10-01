---
name: office-documents
description: Use when producing a file someone will open in Word, Excel, PowerPoint, or a PDF reader - reports, spreadsheets, decks, invoices, exports - to pick the right library, install it on demand, lay the document out properly, and confirm the file actually opens with the content intended.
user-invocable: false
---

# Office documents

A document is not finished when the script exits successfully. It is finished when you have opened
the generated file with a reader and seen the content arrive where you meant it. Everything else
here serves that.

## Choose the format before the library

| Output | Preferred library | Choose it because |
|---|---|---|
| `.docx` | `python-docx` | paragraphs, runs, real paragraph and character styles, tables, sections |
| `.docx` needing exact control | raw OOXML in a ZIP, or an existing template filled in | headers, footers, fields, and numbering are not all exposed by the high-level API |
| `.xlsx` | `openpyxl` | cells, number formats, styles, native charts, formulas |
| `.pptx` | `python-pptx` | slides, layouts, placeholders, shapes, notes |
| `.pdf` | `reportlab` for generated reports; a headless converter when fidelity must match a Word or HTML source | different tools for different jobs - a PDF that must look like a Word document is a conversion task, not a layout task |

Editing beats regenerating: when the file already exists, open it and change what differs.
Rebuilding a document that carried manual edits destroys them.

## Read the matching reference

| Question | File |
|---|---|
| What each container does well or badly, the version floors, installing a library, and the library API that moved | `references/format-and-setup.md` |
| The layout and content rules, and how they read inside Word, a sheet, a deck | `references/layout-and-content.md` |
| How to reopen the output and assert what is in it, format by format | `references/verify-by-reading-back.md` |

Read one with the file-read tool, and read it in windows: a tool result over 8192 code points is
trimmed to its first 4096 plus its last 1024 the next time compaction runs, so a long file read
whole loses its middle. This file stays short for the same reason, and so should every `SKILL.md`
you write. All three references here are short enough to read whole.

## Set up on demand, in the project, not the system

Assume nothing about the machine. Detect, install what is missing, then re-check.

- Probe before installing, and install only the libraries the current format needs. For a one-off,
  `python -m pip install --user <library>`; when the work belongs to a repository, prefer a
  project-local virtual environment. Do not install into a system interpreter when either option
  exists. The probe, install and re-check commands are in `references/format-and-setup.md`.
- A machine without the runtime or without network access is a limitation to report, not something
  to work around silently. When an install fails, say which library and which error - do not fall
  back to hand-writing an approximation of the binary format and presenting it as the document.
- **Treat a version number as a floor that is known to work, never as what is installed here.**
  Let the runtime report the truth, because these libraries move their API between minor versions:

  | Library | Known-good floor |
  |---|---|
  | Python | 3.9 |
  | `python-docx` | 1.0 |
  | `openpyxl` | 3.1 |
  | `python-pptx` | 0.6.21 |
  | `reportlab` | 4.0 |

  Print the installed version, then smoke-test the library on one minimal artifact - write it, save
  it, reopen it, assert one property - before generating anything real. That catches API drift in
  seconds instead of inside a hundred lines of document code. Detail, including the `python-docx`
  change that breaks copied examples, is in `references/format-and-setup.md`.

## Layout rules that apply to all formats

Use one type scale and one spacing scale, exactly as for an interface: a heading, a body, and a
small; multiples of one spacing unit; one accent color. The differences are in what each format
lets you do.

Seven rules carry most of that work, and they are short: **use named styles** rather than
formatting each paragraph; **let content drive layout**, so no cell reference, page number or slide
count is hard-coded; **keep the reader's units**, as cell or field values with a display format
rather than pre-formatted strings; **numbers align right and text left**, one header row style and
a frozen pane when the table scrolls, with column widths sized by the longest realistic value; let
**colour carry meaning or nothing**; and **prefer native chart objects** to embedded images, so the
reader can edit them. Each rule in full, and how it reads inside Word, a sheet and a deck, is in
`references/layout-and-content.md`.

## Verify by reading the file back

Exit code zero proves the script ran, not that the document is right. Reopen the output with a
reader and check the content:

```python
import openpyxl
wb = openpyxl.load_workbook("out.xlsx")
ws = wb.active
assert ws["B2"].value == expected_value
assert ws["B2"].number_format == "0.0%"
```

Assert values **and their display formats**, not just that the file loads. Convert to PDF or images
and look at it when a rendering step exists - for a layout, that is the only acceptance test worth
trusting. What to assert in each format, including the `.docx` and `.pptx` walks and the ZIP parts
behind them, is in `references/verify-by-reading-back.md`.

Finish by opening the file in a real application when you can, and say plainly which checks you ran
and which you could not.

If the layout itself is what reads as unfinished rather than the file, that is a different skill:
`design-quality`.
