# `tsverify view`: the local viewer

`tsverify view` runs the same pipeline as `tsverify check` and shows the results in your browser: the state diagram, the
permission matrix, the plain-English summary, the findings grouped by root cause, and a step-by-step **playback**
of every counterexample. It rebuilds and reloads the page whenever a spec or its project's code changes.

```sh
tsverify view                      # every *.behavior.yaml under the current directory
tsverify view src/orders --open    # one directory, and open the browser
tsverify view --spec-only          # specs only: no code extraction or conformance
```

It prints the URL (`http://127.0.0.1:<port>/`) and runs until you press Ctrl+C. The exit code is 0 after a clean
stop, and 2 for bad options or paths without specs, as with `check`.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `0` | Port to listen on; `0` picks a free one |
| `--host <address>` | `127.0.0.1` | Loopback address to listen on: `127.0.0.1`, `::1` or `localhost`. Anything else is refused (exit 2) |
| `--open` | off | Open the page in the default browser (`open`, `xdg-open` or `start`). Never done by default |
| `--spec-only`, `--project <dir>`, `--max-states <n>`, `--enforced-only` | | As for `tsverify check` |

## Viewing from another machine

The viewer never listens on the network. `tsverify view` prints its local address and the SSH command for reaching it
from another machine:

```
tsverify view
  Local:    http://127.0.0.1:4400/
  Remote:   ssh -N -L 4400:127.0.0.1:4400 <user>@<this machine>, then open http://localhost:4400/
```

When `tsverify` runs on a remote box (SSH, a dev VM, a container) and your browser is on your laptop, `127.0.0.1` in the
URL means the **laptop**. Forward the port over SSH:

1. On the remote box, pick a fixed port: `tsverify view --port 4400`.
2. On the laptop: `ssh -N -L 4400:127.0.0.1:4400 <user>@<remote-host>`. If the box is only reachable through
   another host (a hypervisor, a bastion), add `-J <user>@<jump-host>`.
3. Open `http://localhost:4400/`. A different local port also works (`-L 9000:127.0.0.1:4400` →
   `http://localhost:9000/`). VS Code Remote and similar tools forward ports the same way.

## What the page shows

For each behavior file:

- **Findings**, grouped by root cause like `tsverify check`'s output: a consequence (for example B3's double refund) is
  nested under the finding that causes it (the `non-atomic` refund). Every finding with a counterexample has a
  **Play counterexample** button.
- **Playback** of the chosen counterexample:
  - the state diagram of the model the trace came from (spec or code), with the current status highlighted and
    the acting transition's edge marked `▶`
  - a step slider, play/pause, and speeds from 0.5× to 4×
  - one swimlane per worker that acts, showing its phase (`idle`, `checked`, `done`) and the status it read
  - effect counters with their limit (`/ 1` for an exactly-once effect); on the last step the violated property is
    named and the counter it concerns is marked `✗ violated`
  - the step list from `tsverify check`'s trace text, where each step is clickable
- **State diagram** of the spec model, and of the code model when one was extracted.
- **Summary** and **permission matrix** of the spec.

Keys inside the playback panel: `←`/`→` step, `Space` or `K` play/pause, `Home` first step, `End` last step. Moving
by hand pauses playback.

## Live reload

The viewer watches each spec file and each project's `src/` directory (the project root when there is no `src/`),
ignoring `node_modules`, `.git` and `.tsverify`. After a burst of changes it re-runs the pipeline and the page reloads
its data, keeping the spec and trace you had selected when they still exist. If a rebuild fails (for example
because every spec was deleted), the page keeps showing the last good build with an error banner.

## Security

The viewer is for your machine only.

- It listens on loopback only (`127.0.0.1` by default); a non-loopback `--host` is refused. Other machines reach
  it through an SSH tunnel, never over the network.
- It answers only requests whose `Host` header is a loopback name (`localhost`, `127.x.x.x`, `[::1]`, on any port,
  so SSH tunnels work); anything else gets `403`. This blocks DNS-rebinding pages, whose requests carry the
  attacker's host name, from reading your specs.
- It serves only `GET` and `HEAD`, and has no endpoint that writes anything.
- Responses carry a strict Content-Security-Policy (scripts from the viewer itself only), `nosniff`, and
  `no-store`.
- Everything is served from the installed package: the app is prebuilt into `@tsverify/cli`'s `dist/viewer/`,
  together with the part of Mermaid it uses (state diagrams, laid out with dagre). In a checkout of this repository
  it is bundled with esbuild when the server starts. Nothing is downloaded at run time, and no CDN is used.
