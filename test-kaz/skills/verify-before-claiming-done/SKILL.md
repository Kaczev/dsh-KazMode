---
name: verify-before-claiming-done
description: Use when about to report work as done, fixed, passing, or verified - before saying a file was written, a command succeeded, a rule is enforced, a bug is gone, or a check passed. It sets what counts as evidence, how to test the artifact that will actually run, and how to report the part that was not verified.
---

# Verify Before Claiming Done

A claim of completion is a factual claim about the world. Make it only from evidence you produced
yourself, in this session, about the exact artifact that will run.

## The rule

State work as done only when you have observed it working. Reading the code you just wrote is not
observation. A passing syntax check is not observation. "The pieces look right" is not observation.

When you cannot observe it - no runtime, no credentials, no device - say exactly which part is
unproven and what would prove it. An honest gap costs one sentence; a false "done" costs the
reader's trust and their time rebuilding what you broke.

## Evidence, in descending order of strength

1. **Run the real thing and read its real output.** The program's own output, the file's bytes on
   disk, the screen the user would see, the response body.
2. **Read back what you wrote, from the same place the consumer reads it.** Not the value you
   passed in - what landed.
3. **Compare against an independent source of truth**: a checksum, a byte count, a re-parse, a
   second computation by different means.
4. **A check whose result you actually looked at.** Exit status alone is weak: a pipeline reports
   the last command's status, so a failing command in the middle can still end in `0`.

Prefer the strongest evidence the environment allows, and name which one you used.

## Test the artifact that will run

The most common false "done" comes from proving a copy, a mock, or an older build:

- The file on disk, not the string you passed to the writer.
- The installed/deployed copy, not the source tree. If a build step exists, rebuild and confirm
  the change is present in the output.
- The process that is actually serving, not the one you started earlier. Code that is loaded at
  startup does not pick up an edit; a restart is part of the change.
- The target environment, not your development stand-in. Isolation that you intended is not
  isolation you verified: prove where the write landed, not where you meant it to land.

## Make the test able to fail

A test that cannot fail proves nothing. Before trusting a check:

- Ask what a wrong version would do. If the wrong version also passes, the check is decoration.
- Probe the boundary, not just the middle: one step below, exactly at, one step above.
- Feed it the input you believe it rejects. If the rejection path was never exercised, the rule is
  a hope, not a guard.
- Distrust a check that returns nothing: an unexpected `undefined`/empty result can make every
  comparison trivially false and the whole guard silently inactive. Confirm the guard's own inputs
  are what you assume.

## Take the expected value from the artifact, not from memory

An assertion is only as good as the string you compare against. When you write that string from
recollection of what the file says, you are testing your memory and reporting the result as a test
failure - the artifact is right, your expectation is wrong, and the false alarm costs the same
attention as a real defect.

- **Copy the expected value out of the artifact** - read the file, print the field, quote the line -
  rather than typing it from what you believe it contains. Every expected value should have an
  observed source.
- **Watch the whitespace.** Prose wraps: a sentence you match as one line exists in the file as two
  lines with indentation between them, so `the harness installs a subset` fails against
  `the\n  harness installs a subset` even though the text is plainly there. Assert on a short
  distinctive fragment well inside one line, or normalize whitespace on both sides before comparing,
  and never conclude "the content is missing" from a failed literal match.
- **When a check fails, print both sides before touching anything.** The diff between expected and
  actual is the evidence; without it, "it failed" is a feeling.
- **Re-read after writing.** An edit that silently changes what you wrote earlier is a real hazard,
  and the check that catches it is the same one: read the artifact back.

This is the same rule as elsewhere in this skill, aimed at the test rather than the artifact: the
artifact on disk is the authority, and a failure that exists only in your expectation is not a defect
in the artifact.

## When a test fails, suspect the test

A failing check indicts two things: the artifact and the harness. Before changing the artifact,
work out which one is wrong - an incomplete fixture, a missing field, an environment variable the
code reads but the test never set. Changing working code to satisfy a broken test is how correct
behaviour gets broken.

Conversely, when a check passes on the first try, confirm it exercised what you think: name the
observable you expected and find it in the output.

## Clean up after yourself in the same pass

Evidence-gathering writes things: temp files, probe directories, debug lines inside the artifact.
Any probe you add to real code is a defect the moment it lands - remove it in the same turn,
re-check the file compiles, and confirm nothing else was touched.

## Reporting

Separate the two, explicitly:

- **Verified** - what you ran, and what you saw.
- **Not verified** - what remains unproven, and the smallest step that would settle it.

Report what actually happened, including the parts that failed, regressed, or turned out to be
your own mistake. Name the file, the command, and the observed result. If a claim rests on one
check, say so; do not present a single observation as a general property.
