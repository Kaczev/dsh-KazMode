# Verify by reading the file back

Exit code zero proves the script ran, not that the document is right. Reopen the output with a reader
and check the content:

```python
import openpyxl
wb = openpyxl.load_workbook("out.xlsx")
ws = wb.active
assert ws["B2"].value == expected_value
assert ws["B2"].number_format == "0.0%"
```

Open it with the same library that wrote it, then, when a rendering step exists, convert to PDF or
images and look at it. For a layout that is the only acceptance test worth trusting. Finish by
opening the file in a real application when you can, and say plainly which checks you ran and which
you could not.

## What to assert, format by format

- `.docx`: reopen and walk the paragraphs and tables, asserting the text and the style names.
- `.xlsx`: reopen and assert specific cell values **and number formats**, not just that the file
  loads.
- `.pptx`: reopen and assert the slide count and each slide's title and body text.
- `.pdf`: reopen and extract text, and check the page count.
- `.docx`, `.xlsx`, and `.pptx` are ZIP archives: when a library will not report something, the
  parts can be inspected directly.

## When the check cannot run

A missing runtime, a missing library, or no rendering step is a limitation to report in those words.
Do not describe an unopened file as verified, and do not present a rewrite of the content as a check
of the file: an assertion on the data you passed in is not an assertion on what the reader will see.

## Where this reference stops

What each container is good at, and the version floors for the libraries, are in
`format-and-setup.md`. The rules that decide what goes in the document are in
`layout-and-content.md` and in the main `SKILL.md`.

Read this file in windows if the file-read tool reports it was trimmed: a tool result over 8192 code
points loses its middle the next time compaction runs. Below 200 lines it is read whole.
