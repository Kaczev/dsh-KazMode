# Native programs, exit codes, and the shell's own state

What a native program reports back, and what the shell around it remembers between calls. Both are
read as stronger evidence than they are.

## Calling native programs

- `$LASTEXITCODE` is set by the native call, so read it immediately after that call.
- **Zero is not always success.** Some tools define a range of success codes - a mirroring or copying
  tool typically treats small positive codes as non-fatal. Compare against the tool's own contract
  instead of `0`. winget is the live example in `references\installing-with-winget.md`: the install
  that changed nothing returned a non-zero code while the install that succeeded returned `0`.
- A pipe reports the status of its last command, so a failure upstream can still end in success.
  Collect the exit code per command rather than once per pipeline.
- Quote paths that contain spaces, and be careful when a command itself needs quoting: passing a
  quoted path through another shell layer often needs different quoting again.
- An interrupt usually arrives as a bare non-zero exit after the process was stopped, not as a
  distinguishable signal. Do not read it as a defect in the command.
- A dry run that prints the same success banner as a real run will fool you. Check whether the verb
  you called was the real one before concluding the work landed.

## Shell behaviour worth remembering

- Each invocation is a fresh process: a working directory, an environment variable, or a variable set
  by one call does not exist in the next. Any setup has to be repeated inside the same call.
- **Windows PowerShell 5.1 only:** no conditional chaining (the double-ampersand and double-pipe
  forms), no null-coalescing operator or its assigning form, and no ternary. They fail at **parse**
  time - so nothing in the command runs, and `$LASTEXITCODE` still holds whatever the previous native
  call left in it. Measured: 5.1 rejected `$x ?? "d"` at parse time while 7.6 evaluated the same
  line. Under 7 these operators exist and the rule does not apply.
- An intermittent "cannot replace file" style failure on long non-ASCII writes is usually transient;
  retry the same operation once before investigating.
- To measure the environment rather than assume it: ask the shell for its own version, and ask for a
  command's resolved path, instead of reasoning from which shell you think is installed.
