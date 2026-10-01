# Getting text through the layers intact

A command's text passes through more than one parser on its way to the program that acts on it, and
each layer can change it. These are the three places that goes wrong: the argument list, a nested
PowerShell, and the parse itself.

## Move multi-line content through files, not arguments

The shell does **not** split a multi-line argument: it arrives as one argv element, newlines and
spaces intact, and node, python and `git commit -m` receive it whole. What breaks is something else -
`cmd.exe` truncates at the first newline, and a program that re-splits its own arguments will split
yours. So the failure is real but the mechanism is not the shell's, and a diagnosis built on "the
shell split my argument" will look in the wrong place. Passing a file removes the whole question,
which is why it is the safer habit for a commit message or a request body.

- For a commit message, a request body, or any multi-line argument: write the text to a file and
  pass the file.
- When the output of a native command looks like a PowerShell error, check whether it is really the
  native program's stderr being wrapped. The text inside is usually the real diagnosis.

## Calling PowerShell from PowerShell

A script string that has to survive both an outer and an inner PowerShell is where quoting stops
being tedious and starts being a defect.

- **The outer layer interpolates before the inner shell parses.** Measured here: with the inner text
  reaching the outer command through a double-quoted string, `"a" | "b"` reached the inner shell as
  `a | b` - the quotes were evaluated as empty expressions - and it then failed with a syntax error
  against the inner line you did write. The same inner text passed through a single-quoted outer
  string survived intact, so the layer boundary is not the problem; the outer interpolation is. **A
  pipe inside an interpolated inner script can be consumed before the inner shell ever sees it.**
- The fix is to nest with the inner script containing no quotes or pipes, to pass it as a
  single-quoted literal that nothing interpolates, or to hand the text over encoded so no layer can
  touch it.
- Reduce a nested failure to the smallest inner script that still fails and print what the inner
  shell actually received, rather than adding another layer of quoting.

## When the shell refuses to parse the command

A parse error means nothing ran. The message points at a line, often not the line you would blame, so
read the message for the *token* it objected to rather than the line number. Two traps account for
most of these, and both come from characters that carry meaning inside a string:

- **Do not put a colon immediately after a variable inside a double-quoted string.** The shell reads
  `<name>:` as a drive-qualified reference and stops with a message about the colon not being followed
  by a valid variable name. Write the output as separate pieces, or use a formatting operator, or
  brace the name so the colon cannot attach to it.
- **Escaping characters inside one shell's string, only to hand the text to another matcher, is
  fragile.** If a search pattern needs the shell's escape character, the shell may consume it - or
  veto the whole command - before the matcher ever sees it. Prefer matching a plain substring, or
  build the text in a way that does not require escaping at all.

General habit: when a command fails to parse, do not retype it with more quoting. Reduce it to the
smallest piece that still fails, then look at what that piece actually contains.
