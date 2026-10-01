# Format and setup: choosing the container, and the library that fits it

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
- A machine without the runtime or without network access is a limitation to report, not
  something to work around silently.

## Pin a floor, then detect - never trust memory

These libraries change their API between minor versions, and a guide's example is written against
whichever version its author had. Treat any version number as a **floor that is known to work**,
not as what is installed here, and let the runtime report the truth:

| Library | Known-good floor |
|---|---|
| Python | 3.9 |
| `python-docx` | 1.0 |
| `openpyxl` | 3.1 |
| `python-pptx` | 0.6.21 |
| `reportlab` | 4.0 |

The floor matters because the APIs genuinely moved. `python-docx` is the cautionary example: before
1.0 the namespace was flat (`docx.Document`), and from 1.0 the package exposes a differently
arranged public API (`from docx import Document`). Code copied from an older example fails on a
newer install, and code written against 1.x fails on 0.8 - which means the only safe move is to ask
the installed version which layout it has and write against that.

Do it in this order:

1. **Probe**: print the installed version of the library you are about to use.
2. **Smoke-test before generating anything real**: write one minimal artifact with that library,
   save it, reopen it, assert one property. This catches an API drift in seconds, before it is
   buried in a hundred lines of document code.

```python
from docx import Document            # python-docx 1.x layout
doc = Document(); doc.add_heading("t", level=1); doc.add_paragraph("b"); doc.save("smoke.docx")
back = Document("smoke.docx")
assert [p.style.name for p in back.paragraphs] == ["Heading 1", "Normal"]
```

3. **Prefer what the runtime shows over what you remember**: when an attribute is missing, list the
   module's own contents (`dir(obj)`) or read the installed package's documentation, rather than
   recalling an older signature. The library on disk is the authority.
4. **Record the version in the report** for anything the reader will rerun, so a future failure can
   be traced to a dependency change instead of to the document logic.

## What the PDF container does not share

A PDF is the one output here that is not built from the same tree of styles and placeholders as the
other three. It has no named styles to inherit, no placeholders to fill, and no ZIP parts a library
can be asked about: it is the finished page, the last step in a pipeline. So the way to control one
is to generate it from something that does have structure - a Word document or HTML - and convert,
or to draw it deliberately with `reportlab`. A PDF that must look like a Word document is a
conversion task, not a layout task.

## Where this reference stops

The layout rules that apply to all four containers are in the main `SKILL.md`, their per-format
statement is in `layout-and-content.md`, and what to assert after writing is in
`verify-by-reading-back.md`.

Read this file in windows if the file-read tool reports it was trimmed: a tool result over 8192 code
points loses its middle the next time compaction runs. Below 200 lines it is read whole.
