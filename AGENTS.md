# Task Workspace development

Before editing or testing this plugin in BB, read [DEVELOPMENT.md](DEVELOPMENT.md).
It covers starting or reusing the isolated development profile, installing this
checkout, watching changes, native Node requirements, and verification.
Use `node scripts/bb-dev.mjs cli ...` for development BB commands; bare `bb`
inherits the current thread's profile and can target the everyday installation.

Use GitButler for repository writes. Create or reuse a task branch before edits.
Read [CONTEXT.md](CONTEXT.md) when changing task behavior; linked conversations
remain ordinary BB threads and card movement never starts agent work.

For a requested publication, follow [RELEASING.md](RELEASING.md). Publish only
after the verification and production-only distribution builds pass, and use a
new immutable version tag.
