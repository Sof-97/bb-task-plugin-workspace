# Task workspace

Enroll an existing BB project backed by a GitButler main repository, assign its
task prefix, and manage durable tasks on a manual board. Task identifiers,
workflow, relationships, path references and external memory survive plugin
reloads.

Before repository editing, the human explicitly selects the reusable unmanaged
main-checkout environment and creates, associates or deliberately stacks the
exact GitButler task branch. Missing, renamed, merged, unapplied and mismatched
states remain visible for correction. Preparation never commits,
applies/unapplies, changes task status or starts a thread.

Canonical task memory is external UTF-8 Markdown. Human edits use
dataset/revision/hash preconditions, durable operation IDs and crash-reconciled
staged replacement. External edits, deletion and unsafe file shapes remain
visible; only verifiable byte states offer explicit accept or restore controls.
SQLite stores coordination metadata, not Markdown content.

Ordinary BB conversations can be linked to one task at a time and receive a
fresh ID/title/description/status/project/repository/branch/memory snapshot.
Exactly three narrow agent tools act on the durably linked task; only
`In progress` → `Ready for agent review` is agent-mutable. New linked threads
start through the normal BB composer with its model, mentions, environment and
execution choices preserved.

The read-only Local Wayfinder attaches a repository-relative Markdown map and
explicit sibling ticket directory to a currently prepared task workspace. It
reads the dirty combined checkout through a bounded no-follow host generation,
derives explicit-status tickets, references, diagnostics, SCCs and frontier,
and refreshes through a view-scoped native watcher. It never fetches linked
content or edits tickets, tasks or branches.

The board header shows backup health and offers a manual export. The plugin
publishes one verified local archive on the first use of each local calendar
day, keeps the latest seven valid daily archives, and can restore a whole
dataset from a validated archive with a fresh dataset epoch, preserving the
current state behind a protective pre-restore copy.

A token-authenticated versioned HTTP interface (`capture/v1/projects`,
`capture/v1/tasks`) lets a future local client discover enrolled projects and
submit a minimal Inbox capture with durable retry identity, without exposing any
agent tool, branch, thread or repository side effect.

Install, update, recovery, the capture retry contract, reproducible checks and
the demonstrated-versus-unobserved evidence boundaries are in
[README.md](README.md). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
