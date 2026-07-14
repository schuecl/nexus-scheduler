# Contributing to Nexus Scheduler

Thanks for thinking about using or contributing to this software
("Project") and its documentation!

By participating in this Project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

- [Policy & Legal Info](#policy)
- [Getting Started](#getting-started)
- [Submitting an Issue](#submitting-an-issue)
- [Submitting Code](#submitting-code)

## Policy

### 1. Introduction

The maintainers of this Project will only accept contributions made
under the Developer's Certificate of Origin 1.1 located at
[developercertificate.org](https://developercertificate.org) ("DCO").
The DCO is a legally binding statement asserting that you are the
creator of your contribution, or that you otherwise have the authority
to distribute the contribution, and that you are intentionally making
the contribution available under the license associated with the
Project — the [Apache License, Version 2.0](LICENSE) ("License").

### 2. Developer Certificate of Origin process

Before your first code contribution to this repository, agree to the
DCO by adding your name and email address to
[CONTRIBUTORS.md](CONTRIBUTORS.md). Adding your information to that
file tells us that you have the right to submit the work you're
contributing and that you consent to our treating the contribution in a
way consistent with the License and the intent described in
[INTENT.md](INTENT.md). This one-time sign-off covers all of your
contributions to this Project; you do not need to add a
`Signed-off-by:` trailer to every commit (though you're welcome to).

### 3. Important points

Pseudonymous or anonymous contributions are permissible, but you must
be reachable at the email address provided in your CONTRIBUTORS.md
entry.

If your contribution is significant, you are also welcome to add your
name and copyright date to the source file header.

You do not need to follow the DCO process for submitting issues or for
commenting on this repository's documentation (such as this file or
INTENT.md).

### 4. DCO text

The full text of the DCO is available online at
[developercertificate.org](https://developercertificate.org):

```txt
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Getting Started

Nexus Scheduler is a TypeScript monorepo managed with npm workspaces.
It requires **Node 20+**, **npm 10+**, and **Docker** (for the full
local stack). See the [README](README.md#getting-started) for a full
walkthrough of running the stack with Docker Compose; the short
version for working on the code itself:

```sh
npm install
npm run prisma:generate   # generate the Prisma client
npm run build             # builds all workspaces in dependency order
```

### Checking your changes

Before submitting a pull request, run the same checks CI runs:

```sh
npm run lint        # ESLint across the repo
npm run typecheck   # TypeScript, all workspaces
npm test            # unit/regression tests, all workspaces
```

Some regression tests exercise a real Postgres and Redis; the easiest
way to provide those locally is the Docker Compose stack described in
the README.

### Code style

Code formatting conventions are defined in the
[`.editorconfig`](.editorconfig) file, which uses the
[EditorConfig syntax](https://editorconfig.org). Most editors have a
plugin that applies these settings automatically. Linting is enforced
by ESLint (`eslint.config.mjs`), including async-safety and security
rules — please keep `npm run lint` clean.

## Submitting an Issue

Feel free to [submit an issue](https://github.com/schuecl/nexus-scheduler/issues)
for anything that needs attention — bugs, missing functionality,
documentation, or anything else.

**Security vulnerabilities are the exception:** please do **not** open
a public issue. Follow the private reporting process in
[SECURITY.md](SECURITY.md) instead.

When submitting a bug report, please include:

- Steps to reproduce the problem,
- What you expected to happen,
- What actually happened (or didn't happen), and
- Technical details: the version/commit you're running, how it's
  deployed (Docker Compose, Helm, bare `npm run dev`), and any relevant
  logs.

## Submitting Code

Make your changes on a [branch in Git](https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging)
(in your fork, if you don't have write access), then submit a
[pull request](https://github.com/schuecl/nexus-scheduler/pulls) (PR)
on GitHub. Your pull request will go through automated checks using
[GitHub Actions](https://github.com/features/actions) — build, lint,
tests, dependency audit, CodeQL, secret scanning, and container/Helm
validation.

If this is your first code contribution, include your DCO sign-off in
[CONTRIBUTORS.md](CONTRIBUTORS.md) as part of the same PR (see
[Policy](#policy) above).

After review by the maintainers, your PR will either receive comments
requesting more information or changes, or it will be merged into the
`main` branch.
