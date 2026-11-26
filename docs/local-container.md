# Local containers

Run `yarn local up`. On first use, it creates `.local/container/config.yaml` and `stack.env`. Fill
them in and run the command again. See the [configuration reference](configuration.md). The stack
uses your existing OpenCode config, auth and sessions directly from your home directory.

`up` builds the current checkout and starts the worker. `yarn local logs` shows startup and polling;
`yarn local down` stops the stack and keeps its data. Use `yarn local up` again to rebuild.

Docker Compose or Podman Compose 1.6+ is required. The container uses `SYS_ADMIN` for nested
Bubblewrap; on SELinux with Podman, the launcher disables labeling for this container only. An
optional `.local/container/compose.yaml` can supply the whole stack in place of the default.
