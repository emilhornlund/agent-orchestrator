# Local containers

Run `yarn local up`. On first use, it creates `.local/container/config.yaml` and `stack.env`. Fill
them in and run the command again. See the [configuration reference](configuration.md). The stack
uses your existing OpenCode config, auth and sessions directly from your home directory.

`up` builds the current checkout and starts the worker. `yarn local logs` shows startup and polling;
`yarn local down` stops the stack and keeps its data. Use `yarn local up` again to rebuild.

The worker uses a size-bounded container log (`json-file`, called `k8s-file` by Podman) so a
throttled host journal cannot hide its console output. Persistent task and service logs still live
in the context volume.

The default stack persists Playwright's browser cache across rebuilds so that a resumed task can
reuse browsers installed by a completed setup command. If you use a custom Compose file for such
projects, persist `/root/.cache/ms-playwright` (or the browser cache path configured for your
worker). Before replacing an existing worker with an unmounted cache, copy that cache into the
persistent mount if an active task depends on it.

Docker Compose or Podman Compose 1.6+ is required. The container uses `SYS_ADMIN` for nested
Bubblewrap; on SELinux with Podman, the launcher disables labeling for this container only. An
optional `.local/container/compose.yaml` can supply the whole stack in place of the default.
