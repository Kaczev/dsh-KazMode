---
name: orienting-in-a-codebase
description: Use when starting work in a repository you do not already know - finding where a capability lives, deciding which layer an edit belongs to, judging which files are authoritative, or when a search returns nothing and you are about to conclude the feature does not exist.
---

# Orienting in a codebase

The goal is not to read the repository. It is to find the few files that decide the behaviour you are
about to change, and to know which files are not evidence.

## Find the boundaries before the details

Answer four questions first; each one narrows every later search.

1. **Where does execution start?** The entry point, the registration site, the composition or config
   file that names components. A capability that is never registered cannot run, however correct its
   code is.
2. **What is generated?** Build output, bundled libraries, and vendored code sit beside real sources
   and look identical in a file listing. Find the build config and the ignore files: anything
   produced by a build is not documentation and not a place to edit.
3. **What does the tooling enforce?** The repository's own agent instructions, contributor guide, or
   package scripts encode the conventions that matter - naming, file layout, where tests live, which
   command proves a change. Read those before writing code, not after a review rejects it.
4. **Which layer owns the change?** Shared registries and host-level services usually live outside
   the feature directory, while per-session or per-request behaviour lives inside it. Getting this
   wrong produces a change that works in one context and is invisible in another.

## Search so that a miss means something

A search that returns nothing is the easiest way to reach a false conclusion.

- **Search sources and documentation, not build artifacts.** A capability can exist and be absent
  from its bundled form - minification, renaming, and dead-code elimination all hide text. A miss in
  a bundle is not evidence of absence.
- **Search for the shape, not the spelling.** Variants of a call, a parameter, or a naming convention
  will not match one literal pattern. Search for the distinctive fragment, then read the file.
- **Check both definition and use.** If a symbol is defined but never referenced, the question is not
  what it does but why nothing calls it.
- **Prefer authoritative text.** A type declaration, a schema, or a test that asserts behaviour beats
  a comment, a README, and a changelog. When they disagree, the test and the types win.
- **Read the neighbours.** The most reliable guide to how a thing is done here is a sibling that
  already works: copy its shape, its registration, and its test layout rather than inventing one.

## Follow one path end to end

Before editing, trace a single real invocation from the entry point to the effect:

```sh
# find the registration, then follow outward
grep -rn "<capability-name>" <source-dirs>
# then confirm which of those files is actually loaded
```

Reading one complete path teaches more than skimming ten files, and it is the only way to see the
seams where the data changes shape.

## Know what "it works" means here

Match the evidence to the ecosystem:

- Call the public interface and read its output.
- Read back the artifact the consumer reads, not the value you handed to the writer.
- If a build, install, or deployment step exists, the source tree is not the artifact.
- If the process loads code at startup, editing files changes nothing until it restarts.

State which of these you did. In an unfamiliar repository, an unverified assumption about the
toolchain is indistinguishable from a bug.

## Before you conclude something is missing

- It exists under another name. Search for the concept, then for its synonyms.
- It is generated at build time. Look for a template, a generator, or a codegen script.
- It lives in a dependency. Check what the manifest declares before searching the tree.
- It is configured off. A disabled component looks exactly like an absent one.
- You searched an artifact instead of a source. This is the most common of the five.
