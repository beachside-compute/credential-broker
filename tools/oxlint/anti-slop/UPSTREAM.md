# Anti-slop source

Installed without rule changes from [Beachside's install-anti-slop skill](https://github.com/beachside-compute/beachside/tree/676c620724172b327d048202ded23867ebe46491/.agents/skills/install-anti-slop) at commit `676c620724172b327d048202ded23867ebe46491`. The skill's asset tree is `75d274722cd4820ba43341281fb7af3426673d59`.

The installer copied the bundled generic and Effect plugins and nested vendor files to `tools/oxlint/anti-slop/`. This repository enables the generic plugin. The Effect plugin stays inactive because the repository has no direct Effect dependency.

The Stylistic padding rule retains its [upstream record](./vendor/eslint-stylistic/UPSTREAM.md) and license.
