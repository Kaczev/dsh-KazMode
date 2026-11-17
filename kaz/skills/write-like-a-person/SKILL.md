---
name: write-like-a-person
description: Use when the requested deliverable is a prose composition or substantive prose revision, such as an article, speech, report, documentation, or a substantial passage of UI copy; when the user asks to revise a prose draft that sounds like AI or reads awkwardly; or when the user explicitly asks to apply this skill. Do not load solely for ordinary chat replies, code investigation, implementation, debugging, concise technical explanations, working plans, progress updates, or completion summaries. Load when the writing phase begins, not at task startup; reuse loaded instructions while available in context.
---

# Write like a person

Apply the stages below in order to the requested prose. Keep working notes out of the deliverable. Skip a conditional step when its condition is absent. For a local revision, work on the requested passage and check its connections to the surrounding text; do not rewrite unrelated passages.

## 1. Before drafting

1. Record the reader, intended use, requested length, format, and language from the request and supplied material.
2. List the questions the piece must answer and the information the reader must receive.
3. Mark passages the user has corrected or required you to retain, including specific words and the ending. Preserve them during later edits. If a required correction conflicts with facts or another requirement, identify that conflict before changing the passage.
4. Match each required answer to its supporting material. Separate sourced facts, attributed views, and your own inferences in these notes.
5. If missing information would change an answer, request that information or mark the answer as unresolved. Do not invent it. Do not ask about details that would not affect the piece.

## 2. Draft

1. Follow the user's requested order. If no order is given, place definitions before claims that require them and evidence beside the claim it supports. In an argumentative assignment, state the claim before the extended evidence; do not impose that opening on other genres.
2. Write the required answers with their supporting facts, reasons, and qualifications. Attribute reported views; label your own inferences and unresolved claims.
3. Replace planning labels with the actual subject, action, or claim they stand for. Do not transfer a planning metaphor into the draft merely because it is already written.
4. Use the requested genre and voice. Do not copy the user's unrelated writing habits from samples; retain their explicit corrections.

## 3. Revise paragraphs

Perform these steps on the completed draft before editing individual sentences.

1. Assign each paragraph a required answer or a supporting function. Remove paragraphs with neither, after moving any required information into a retained paragraph.
2. Compare the paragraph sequence with the required answers. Add missing answers from the supplied material; mark unresolved gaps rather than filling them with guesses.
3. Move definitions, evidence, conditions, and explanations next to the passages that need them. Remove background that neither supports an answer nor establishes information the reader needs.
4. Where passages repeat the same claim, combine them and retain each distinct fact, qualification, and reason. Do not merge different claims merely because they share words.
5. Exclude protected passages from deletion tests. Test the first and last sentence of each remaining paragraph by removing them in turn. Delete a tested sentence only if the remaining text retains its information and connections. Move any unique information out of an otherwise removable sentence first.
6. Remove sentences that only announce the next section, praise the writing, advertise honesty or rigor, or prescribe the reader's reaction. Retain the actual finding, uncertainty, reason, or test. Keep navigation needed to locate or perform something in the document.
7. Remove rebuttals to views absent from the request, sources, and argument. Keep contrasts that distinguish claims the piece actually needs to distinguish.
8. Where repeated three-part lists or paired contrasts force different points into the same form, rewrite the affected passages around their actual relationships. Keep lists and contrasts that convey required distinctions; do not enforce a numerical quota.
9. Check the ending against the requested use. Retain a requested summary or next step; remove a recap that only repeats the body without serving that use. Do not invent a new claim or rhetorical question to make an ending. Preserve the user's supplied ending.

## 4. Revise sentences

1. For each pronoun or unnamed reference, identify its referent in the text. If several referents fit or none is named, use the material to confirm the intended referent before substituting its name. If the material cannot resolve it, request clarification or mark the reference as unresolved; do not choose a candidate by guesswork.
2. Where an action lacks an identifiable actor or object, supply the missing part from the material if the omission obscures who does what. Keep grammatical omissions whose referents are unambiguous. Do not invent an actor to complete a sentence.
3. Where a subject is assigned an intention, choice, or human action it cannot perform in the intended sense, name the responsible people from the material or describe the actual process. Do not change literal technical terminology on the basis of its wording alone.
4. For each verb and its object, check whether the verb denotes the action performed on that object in the intended language. If not, replace the verb or rebuild the clause around that action. Preserve the actor, object, result, and qualifications; do not translate a foreign phrase word by word.
5. For each causal or inferential claim, locate its supporting premise and the relation it establishes. Add an available missing premise. If evidence supports an inference but does not establish it, state that evidence and label the inference and its uncertainty. If no evidence supports the relation, withdraw it and retain only the supported observations. Adding a hedge or removing a connective alone does not repair an unsupported claim.
6. For each transition, identify the relation between the adjacent passages. Remove a transition that merely announces order or repetition when the relation is already explicit. If a transition asserts the wrong relation, replace it with the supported relation or separate the claims.
7. For each negation, identify exactly what is denied and under which conditions. Rewrite clauses whose word order makes that scope ambiguous. Retain factual exclusions and corrections; do not require all denials to answer a previously quoted view or occupy a fixed sentence position.
8. Rewrite each newly introduced metaphor literally in working notes. Use the literal version if it retains the information and intended judgment. If the metaphor adds an unsupported judgment, remove that judgment or state it with its basis. Preserve protected wording, attributed figures, literal technical terms, and figures whose removal would lose required meaning. Repair mixed comparisons by expressing each underlying claim directly.
9. Replace an unexplained abstract label or borrowed jargon with the action, entity, or distinction it names. Keep established terms needed by the reader; define them when the intended reader cannot be assumed to know them.
10. Delete modifiers that add no degree, condition, distinction, evidence, or requested emphasis. If an assertion of certainty or importance lacks support, remove it or state the available reason and uncertainty.
11. Split a sentence when nested clauses obscure which condition or action belongs to which subject. Join adjacent fragments when they describe one action or dependency and separating them hides that relation. Preserve deliberate emphasis; do not alternate lengths or impose a sentence-length quota.

## 5. Scripts intended for speaking

Apply this stage only to prepared speeches or spoken scripts, not ordinary conversation or tone-pipeline replies.

1. If the script accompanies slides, place `【翻到第 N 页】` on its own line at each slide change. Replace N with the actual slide number. Do not substitute page-range headings for cues; if slide mapping is missing, request it rather than inventing numbers.
2. Count the actual spoken text with a counting tool or script. Exclude page cues, stage directions, formatting markers, and nonspoken annotations. State the count and counting convention; do not estimate the count by feel.
3. Use the requested speaking rate. For Chinese without a specified rate, use 220 Chinese characters per minute and calculate minutes as the spoken character count divided by 220. Do not silently use that rate for another language; obtain or explicitly state the rate used.
4. Compare the calculated duration with the time limit. If required content does not fit, report the count, duration, and excess, and offer explicit cuts or a longer time allowance. Do not silently remove required content or exceed the limit.
5. Identify optional sentences that can be removed without losing a required answer or breaking a dependency. Mark them outside the spoken text and calculate the time each cut saves at the selected rate. Do not invent dispensable material merely to provide cut points.

## 6. Before delivery

1. Compare the revised text with the request, source material, and protected passages. Restore any accidentally omitted required information, negation, condition, commitment, attribution, or supported distinction. Do not restore unsupported claims removed during revision.
2. Check names, numbers, dates, quotations, and citations against the supplied sources. Leave unresolved facts marked rather than presenting them as verified.
3. Recheck sentences affected by deletions, moves, and substitutions for missing referents, premises, or qualifications. Repair the affected connections.
4. Check the requested length, format, and language. Recount a spoken script after the final edit.
5. Deliver the prose, not the working notes or checklist. When revising, briefly identify substantive changes by quoting the changed wording and its replacement or describing the removed passage and why. Explain any authorized change to a protected passage. If the user requests only the finished text, omit the change report.
