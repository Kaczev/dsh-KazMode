---
name: write-like-a-person
description: Use when the requested deliverable is a prose composition or substantive prose revision, such as an article, speech, report, documentation, or a substantial passage of UI copy; when the user asks to revise a prose draft that sounds like AI or reads awkwardly; or when the user explicitly asks to apply this skill. Do not load solely for ordinary chat replies, code investigation, implementation, debugging, concise technical explanations, working plans, progress updates, or completion summaries. Load when the writing phase begins, not at task startup; reuse loaded instructions while available in context.
---

# Write like a person

These are not suggestions. They are corrections the user has already made, across several projects. The rules below are the general form. The examples in this file are ordinary work prose on purpose: a rule you can only recognize in one project's sentences is not a rule yet.

## The rule underneath all the others

A person writes because they have something to say. A machine writes because an answer has a shape that needs filling. Both produce grammatical sentences; only one produces a voice.

So every sentence faces two questions:

1. **Can the reader take it in on one pass?** If they have to hunt for the subject, re-read a clause, or guess what a pronoun points at, the sentence failed.
2. **Would a person who knows this subject, writing for this occasion, say it this way?** If not, the sentence is performing. It may be clear, accurate, and still sound like a system.

The first question catches confusion. The second catches imitation. A lot of AI-flavored prose passes the first and fails the second, which is why "make it clearer" does not fix it.

A one-line reply needs these two questions, not the occasion worksheet or the full pass below. Those are for anything you draft as a document or deliver as finished prose.

## Before the first sentence: what is this piece?

A person writes toward an occasion. A machine writes toward completeness. The difference shows up before the first sentence, in what the piece includes.

Answer three questions before drafting:

- **Who reads this, and what do they already know?** The reader's starting point decides what must be explained and what can be named.
- **What is this piece for?** A course essay, a status report, a wedding toast, and a design doc want different things. The genre is part of the voice.
- **What should the reader leave with?** One thought, one decision, one image, one next step. If you cannot name it, the piece will try to leave them with everything.

Then apply the section test: **for each section, ask whether a person writing this occasion would include it.** Sections that exist only to display rigor — a falsifiability rubric, a limitations section, a "let me be honest" confession, a summary of the summary — are the machine's answer to "prove you are serious." If deleting a section loses only the appearance of rigor, delete it.

Do not import a structure from another genre. A thesis defense, a consulting deck, a Wikipedia article, and a five-paragraph essay each have their own scaffolding. Scaffolding is not argument. A course essay that ends with a rubric is not a more rigorous essay; it is a different document.

Your notes are not a draft. Phrases you coin while planning — a metaphor, a label, a way of putting the argument — are there to help you think, not to be handed to the reader. When you start drafting, say the idea again in the voice of the piece. If a phrase survives from the notes, it should be because it is the best way to say it, not because it is already written.

## The shape is the biggest tell

Sentence-level habits can all pass while the piece still sounds like a machine, because the machine's signature is often the **order of the moves**. A common AI essay goes:

1. correct a view the reader probably did not hold ("课本上讲的是……其实……");
2. list evidence in parallel;
3. announce the synthesis ("把这几件事放在一起……");
4. concede in a tone that advertises honesty ("还有一种更难听的可能……");
5. offer a test or a rubric ("十年之内应该能看到……");
6. close with a rhetorical question that restates the theme.

Every move can be grammatical and locally clear. Together they are a template. A person writing this essay would start from the thought, not from the need to appear rigorous.

Before fixing sentences, write the move sequence in one line per paragraph. If it matches that template, change the shape: cut the strawman, state the synthesis instead of narrating it, drop the staged concession, and end where the thought ends. **Do not compress a section the occasion does not need into one sentence; the move is the problem, not its length.**

Two more shape tells:

- **The rule of three.** One triad can be emphasis; three is a pattern. Count the three-part lists. Cut or vary all but the one doing real work.
- **The not-X-but-Y contrast.** "不是……而是……" and "不只……还……" are strong moves; a piece that uses them every other paragraph is arguing by symmetry, not by evidence. Keep the one that carries the turn; rewrite the rest as plain statements.

Test: cover the paragraph's first and last sentence and read only the middle. If the middle is a list of facts and the first and last are the argument's scaffolding, the shape is doing the work the thought should do.

## The stance is the last tell

A piece can pass every sentence rule and every shape rule and still sound like a machine, because the machine writes like a columnist: it has a verdict on everything, it opens with a law of history, and it ends every paragraph with a line worth quoting. A person writing a course essay is allowed to be unsure.

- **Mark what is yours.** A measurement, a cited result, and your inference should not wear the same tone. 这次改版的复购率提高了 4 个百分点 is a result; 我猜原因是新入口更好找 is a guess; 两者之间还差一步 is the gap. If the sentence is a guess, say so; if it is a fact, give the source.
- **Let some paragraphs end flat.** A paragraph can end on a date, a number, or a plain sentence. If every paragraph ends with a line that could be pulled out as a quote, the piece is performing.
- **A leading metaphor has to survive repetition.** A figure that runs through the whole piece earns more scrutiny, not less. If it is cute but slightly wrong, the third repetition turns it into a gimmick. Sustained is not the same as right.
- **In a course essay, state the claim early.** The reader should know what the evidence is for; do not make them read a page of history first. A magazine feature can delay the thesis; an assignment usually cannot.

Do not solve this by imitating the user's own prose. The target is a person writing, not this particular person's handwriting. A corrected sentence is a decision; a sample of the user's writing is not a template.

## When revising a text the user has already corrected

If the user has already marked sentences or supplied a replacement, that is the target, not a suggestion. Read the corrections first. A rewrite that is smoother but loses the user's specific image, claim, or ending is a regression, even if every sentence passes the habits.

- Keep the user's ending if they wrote one. Do not replace it with a generic conclusion or a rhetorical question.
- Keep the user's concrete word when it is the point. Do not smooth it into a more generic metaphor.
- If you change a corrected passage, say why; do not silently improve it.

## The twelve habits

### 1. Finish the sentence

Give the subject, the verb, and the object. Complete clauses read smoothly; clipped ones make the reader fill gaps.

- No: 经过讨论，决定先做。
- Yes: 产品组决定先做搜索改版。
- No: 因为时间关系，就不展开了。
- Yes: 因为时间关系，这里不展开第三个方案。

Test: after each sentence, ask who did what. If the answer is not on the page, the sentence is not finished.

### 2. Name it, do not point at it

"This layer", "that line", "this one", "in this sense" all send the reader backwards to find a noun you did not say. In Chinese the common forms are 这一层、这条线、这个层面、在这个意义上. They feel precise because they sound structural. Usually they are a taxonomy the writer never built.

- No: 问题就出在这一层。
- Yes: 问题出在权限校验这一步。
- No: 销售这条线已经见顶，产品这条线还在增长。
- Yes: 靠渠道扩张拉动的销售已经见顶，产品本身的增长还在继续。

Test: replace the pointer with the noun it points at. If the sentence gets clearer without getting longer, the pointer was hiding a missing name. If you cannot supply the noun, you do not yet know what you are saying.

### 3. Put the negation where the reader can use it

A negation is a correction. The reader must know what is being corrected before they meet the denial. Two failures follow from this: denying something you never raised, and parking the denial at the end of the sentence.

- No: 这里有个常见的误解要纠正：它不是服务器太慢。
- Yes: 这次卡顿不是服务器太慢，是请求在高峰期排不上队。
- No: 系统里不存在一个既能离线又能实时同步的方案。
- Yes: 系统里，既能离线又能实时同步的方案是不存在的。

Test: the thing you deny must already be on the page, and the denial must not be the last thing the reader hears. If the reader has to ask "who said that?", the negation is premature.

### 4. Do not give abstractions human actions

Nature does not "provide" things. An equation does not "want". A theory does not "refuse" a test. When an abstract noun takes a verb that requires a person, the reader loses the actor.

- No: 市场不答应这个价格。
- Yes: 客户不接受这个价格。
- No: 这个架构想要把耦合降下来。
- Yes: 这个架构把模块之间的耦合降了下来。

Test: can the subject do the verb in the sense the sentence needs? If not, name the people who did it, or say what follows from what.

### 5. Use words that go together

Chinese verbs are choosy about their objects. A phrase can be grammatical and still be a phrase no one says. This is a common way machine Chinese differs from human Chinese: the sentence is built from an English frame, every word is translated, and the verb and the object never meet in Chinese.

- No: 这次改版拿到了用户的喜爱。
- Yes: 这次改版受到了用户欢迎。
- No: 之所以失败，都因为预算不够。
- Yes: 之所以失败，是因为预算不够。

"拿到" takes a key, an offer, a place. A feeling is 受到、赢得、得到; a capacity is 获得、具备、形成. And when the concrete instances are already on the page, do not replace them with an abstract summary noun.

- No: 三个模块都支持离线、重试和断点续传，这些能力说明系统很稳。
- Yes: 三个模块都支持离线、重试和断点续传，系统因此很稳。

Test: say the phrase out loud as a sentence to a colleague. If you would never say it, do not write it. If the phrase is a word-for-word translation of an English phrase ("acquire an expressive capacity", "at this level", "the window closed"), rebuild it from the Chinese verb that actually takes that object.

Borrowed jargon is the same failure at the level of the whole sentence: 赋能、抓手、赛道、维度、闭环、颗粒度. If the subject is not a business, these words are costume.

### 6. Earn every connective

所以、因此、于是、可见、这说明 are claims about the relation between two sentences; 之所以 makes the same kind of claim inside one sentence. If you cannot point to the premise, the connective is decoration. The premise must be on the page before the conclusion asks to be accepted. A 因为 clause can follow the conclusion because it explains it at once; a 所以 cannot point at a premise that was never stated.

- No: 所以，这次改版的关键是速度。
- Yes: 用户流失发生在等待超过三秒之后。所以，这次改版的关键是速度。

Test: for every connective, write the premise in the margin. If you cannot, cut the connective and let the sentences stand. A paragraph that opens with "所以" but introduces a new topic is using causality as a transition; that is a false bridge.

Stock connectives are the opposite failure: all relation, no content. 首先、其次、最后一点、综上所述、值得注意的是、不难发现、众所周知、由此可见、换言之、换句话说. If the relation is real, the sentences will show it; if it is not, the phrase will not create it. Replace them with the actual relation (不过、因此、十年之后、现在说开头提到的那个) or with nothing.

### 7. Do not narrate your own writing

Say the thing. Do not announce that you are about to say it, where you will come back to it, or what the reader should notice.

- No: 下面我从三个方面展开。
- No: 这一点后面还会提到。
- No: 先说结论：这个方案可行。
- No: 把这几件事放在一起，下一次大综合的样子大致是……
- No: 我们大概要先回答一个问题……

Test: delete the sentence. If the next sentence still works and no information is lost, the sentence was stagecraft. Most sentences that describe the writing rather than the subject fail this test.

### 8. Do not tell the reader what to conclude

Let them draw the conclusion. Do not hand it over, and do not tell them how seriously to take the text. This is where a lot of machine prose starts to feel staged: it supplies the fact and then supplies the reaction, as if the reader cannot be trusted to have one.

- No: 这份数据说明我们的方向是对的，可以继续投入。
- Yes: 这份数据里，复购率提高了 4 个百分点。
- No: 如果这份报告只写到这里，它就是公关稿。
- Yes: 这次改版还有三个问题。第一，……
- No: 我给它定三条考核标准。
- No: 必须承认，这件事很难。
- No: 还有一种更难听的可能：不是 AI 不行，而是理论物理已经到顶了。
- No: 十年之内应该能看到一件事：……

A person who is actually being careful gives the specific reason, the actual uncertainty, or the test that would settle it. They do not announce that they are being rigorous, and they do not label their own draft. If you have a real test, state it as a sentence; if you do not, do not manufacture a rubric. A concession that advertises its own difficulty, or a test that turns a paragraph into a rubric, is still staged rigor even when it is one sentence.

Test: does the sentence contain a fact, a reason, or a concrete uncertainty? If it only contains a judgment about what the reader should think, cut it. "真正的" and "本质上" are not banned, but they are claims that a surface reading is wrong: if you have not named the surface or the specific thing that makes the claim true, the word is empty.

### 9. Use a metaphor only when it carries the thought

A metaphor is a loan against the reader's attention. Pay it back with meaning the literal sentence cannot carry. Machine metaphors are often drop-in: they are minted for one sentence to avoid saying the thing, and they import a frame from accounting, engineering, or marketing that the subject never had.

- No: 这次增长的红利窗口已经关上了。
- Yes: 靠买量增长的那条路已经走不通了。
- No: 公司的内核是执行力。
- Yes: 公司的核心能力是执行力。
- No: 这个季度还欠着一笔账。
- Yes: 这个季度还没有拿出可验证的结果。

Three things separate a working figure from a drop-in one:

1. **It belongs to the frame the sentence is already in.** 路 fits a paragraph about a route; 核心能力 fits a paragraph about what a company can do. 窗口 and 内核 come from opportunity and operating systems, and they bring those frames with them. Newton's wound-up clock is Newton's own figure, so it stays.
2. **It is sustained.** A figure that organizes a whole passage can be plain on its own; a figure that appears for one sentence and disappears is usually decoration. A pipeline in a piece about automated production can stay; a "ledger" that appears once cannot.
3. **It does not smuggle in a judgment.** "窗口关上" hides the judgment that a route is closed; say the route and say the regret. "这个季度还没有结果" is a fact; "还欠着一笔账" turns it into a debt. Say the fact, or say the judgment out loud.

Test: rewrite the sentence literally. If the literal version says the same thing more clearly, the metaphor was decoration. If the metaphor carries a judgment, state the judgment instead of smuggling it in. Do not mix domains in one clause: "把方法塞进自己的操作系统" borrows from physical placement and computing at once.

### 10. Vary the sentence length

A run of short sentences reads like a slide deck. A run of long sentences reads like a report. Let the thought set the pace: a long sentence for the qualification, a short one for the landing.

- Machine: 我们先降本。再提效。最后控风险。
- Person: 我们先砍掉两条不赚钱的产品线，再把客服响应压到一天以内；这两件事做完，才有余力谈风险。

If every sentence is the same length, the reader hears a metronome, not a person.

### 11. Mark where the reader should turn the page

In a script or spoken text, the reader cannot guess when the slide changes. Put the cue on its own line: `【翻到第 N 页】`. Do not head sections with slide numbers like "第 1—2 页"; that is scaffolding for the writer, not information for the reader.

### 12. End with a turn, not a recap

A recap tells the reader nothing is coming, so attention drops. But "end with an action" is only one kind of ending. An essay can end with a concession, an image, a question, a change of scale, or the consequence of the argument. What it cannot do is restate the body.

- No: 这次改版的成果可以压成一句话：更快、更稳、更便宜。
- Yes: 我们不知道下一次增长会从哪来，但可以确定，它不会来自去年的那张路线图。

Test: does the last paragraph add a thought that was not already on the page? If it only restates, cut it. If it adds a thought, it can be quiet.

## The pass before you send

The habits above fail in a predictable way: they are read once, at the start of a session, and then the draft is written from memory. That is not a pass; it is a style briefing. Run this on the finished text, with this file open.

1. **Outline the moves.** Write one line per paragraph: what it does (correct a view, list evidence, announce synthesis, concede, test, ask). If the sequence matches the template in "The shape is the biggest tell", change the shape before fixing sentences. Count the triads and the not-X-but-Y contrasts; cut or vary all but the one doing real work. Where does the claim first appear? In a course essay it should be early enough that the evidence has a question to answer.
2. **Read as a stranger.** Mark every place where you had to supply a fact, a referent, or a premise that is not on the page. Circle every 这、那、它、该 and every 这一层、这条线、在这个意义上; name the noun or cut the pointer. For every 不是、不、没有, ask whether the denied thing was already on the page. Count the sentences under six characters; expand any that are not deliberate emphasis.
3. **Delete.** For each paragraph, try deleting the first sentence and then the last. If nothing is lost, delete it. This is the fastest way to find stagecraft.
4. **Check every connective.** For each 所以、因此、于是、可见、这说明、之所以, write the premise in the margin. No premise, no connective. Replace 首先、其次、最后一点、综上所述、值得注意的是、不难发现、众所周知、由此可见、换言之、换句话说 with the actual relation, or with nothing.
5. **Check every verb-object pair.** Read the text aloud. Would a Chinese speaker say it? Rebuild the translationese. When the concrete instances are already on the page, do not replace them with an abstract summary noun. Where you stumble, the reader stumbles.
6. **Check every metaphor.** Rewrite it literally. Keep only the ones whose literal version loses something, and make sure each one is sustained or native to the frame. Do not mix domains in one clause.
7. **Check the judgments.** For every 真正的、本质上、必须承认、显然、最…的是, ask what fact or reason is on the page. If the sentence only tells the reader how to feel or how seriously to take the text, cut it. Mark every sentence that is a guess; does it sound like a guess, or like a measurement?
8. **Check the sections.** List them. Would a person writing this occasion include each one? Cut the ones that exist only to prove rigor.
9. **Check the ending.** Does it add a thought, or restate? If the user supplied an ending, compare against it; do not replace it with a generic conclusion or a rhetorical question. Read the last sentence of each paragraph: if every one is quotable, let some end on a fact.
10. **Report the substantive changes.** Quote the phrase that changed and say what it changed to. Do not paste the checklist unless the user asks.

## When the text is meant to be spoken

Timing is a hard constraint, not a target. A speaking rate of 220 Chinese characters per minute is a good default. Count the actual characters of the spoken text only — strip stage directions, page cues, and markdown — and state the resulting duration. Do not estimate the length by feel; the estimate is wrong far more often than the count.

If a requested structure does not fit the time budget, say so with the numbers and offer explicit options. Do not quietly compress what the user asked for, and do not quietly exceed the limit.

Leave cut points for the speaker: mark the sentences that can be dropped without breaking the argument, and say how much time each one buys.

## Where these came from

These habits were worked out across several rounds of correcting machine-written drafts in different subjects. The rules are the general form. The examples in this file are generic on purpose: a rule you can only recognize in one project's sentences is not a rule yet. The specific corrections that produced them are not published.

The examples are specimens, not the boundary. When a new sentence feels machine-written but does not match any example, classify it by the test, not by the wording. The subject changes; the failure modes do not.
