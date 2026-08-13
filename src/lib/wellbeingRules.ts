// ─── WELLBEING.md as code ─────────────────────────────────────────────────────
//
// This file has no functions in it. It exists so that the three decisions below
// are somewhere a person will actually run into, instead of in a chat log nobody
// will read again.
//
// Every one of these is a thing that feels obviously good to build. That is what
// makes them worth writing down: nothing here will be prevented by taste or by
// remembering, only by having already argued it out once and recorded the
// answer.
//
// ═════════════════════════════════════════════════════════════════════════════
// 1. NO DAILY MOOD FIELD. NOT EVER.
// ═════════════════════════════════════════════════════════════════════════════
//
// The instinct is unarguable: you cannot improve what you do not measure, and a
// wellbeing feature with no numbers feels unserious.
//
// The evidence goes the other way. Qualitative reviews of mood-tracking apps
// find a substantial minority of people made worse by the act of rating: some
// only realise their mood is low because the app made them score it, some
// ruminate on the low scores, some end up checking compulsively, and people with
// low motivation struggle most of all — which is the population this is for.
//
// And the trade buys nothing. The same reviews find mood monitoring does not
// reliably move symptoms in either direction. So it is a real risk of harm in
// exchange for an effect that does not show up.
//
// What replaced it: one bit per task, want or must, answered or skipped. See
// components/IntentPicker.tsx.
//
// ═════════════════════════════════════════════════════════════════════════════
// 2. NO STREAK THAT RESETS TO ZERO.
// ═════════════════════════════════════════════════════════════════════════════
//
// A counter is the single most effective retention mechanic there is, and an app
// nobody opens helps nobody, so this one has a real argument behind it.
//
// It loses on its own terms. A meta-analysis of mental health apps found
// attrition was LOWER in apps without gamification — alongside reminders and
// human support as the things that did keep people engaged. Reminders are fine.
// Points and streaks are not, and the difference is not a matter of taste.
//
// A forty-day count that becomes a zero over one bad Tuesday punishes exactly
// the day that needed the app most.
//
// What replaced it: never miss twice. One miss does nothing at all. Two in a row
// and the task quietly shrinks to its smallest version. See lib/cycles.ts.
//
// ═════════════════════════════════════════════════════════════════════════════
// 3. NO COMPLETION RATES, NO MONTH-OVER-MONTH CHARTS.
// ═════════════════════════════════════════════════════════════════════════════
//
// Every task app has a progress dashboard, and the number is free to compute.
//
// Two reasons not to. The first is that the number is not the useful one: a
// secondary analysis of 78 patients doing behavioural activation found that what
// predicted improvement was the pleasure a person EXPECTED from an activity when
// planning it, while the count of tasks completed predicted nothing. The
// effortless metric is the one that does not matter.
//
// The second is what the chart becomes on a bad month. A line showing someone
// their worst four weeks, next to their best, is an object to ruminate on. It is
// not information anybody acts on, and this app is used by someone with
// depression, where rumination is a symptom rather than a mood.
//
// The progress bar that exists on the task list is bounded on purpose: today
// only, no history, and it does not appear until something has been ticked.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE UNDER ALL THREE
// ═════════════════════════════════════════════════════════════════════════════
//
// Silence is the default, and every message must earn its way onto the screen.
// An alert that fires often enough to become routine is one nobody reads, and it
// stops working on the day it would have mattered. This is why the distress
// matcher is quiet and easy to ignore, why the week sentence needs three
// answered tasks and appears at most weekly, and why the important-things card
// asks to be reviewed twice a year rather than monthly.
//
// If a future version of this app wants a number on the front page, the question
// to answer first is not "can we compute it" but "what does this look like on
// the worst day of someone's year".

export {};
