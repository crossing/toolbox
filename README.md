# Safe CLI

A collection of small tools and integrations to make it safer for AI agents to work with CLI tools by preventing secret leaks.

## Tools

### `safe-op`
A wrapper around the 1Password CLI (`op`) that prevents secrets from being output directly to a TTY or a file.

- **Mandatory Usage:** AI agents must use command substitution (e.g., `SECRET=$(safe-op ...)`).
- **Security Block:** If `safe-op` detects that its output is not a pipe, it will block the execution and provide an instruction to the agent.
- **Runtime Dependency:** Requires `op` to be available in the runtime `$PATH` (e.g., from the 1Password desktop app).

### `op-oauth2c`
An integration between `oauth2c` and 1Password to perform OAuth2 flows without writing tokens to disk.

- **Usage:** `op-oauth2c <1password-item-name> <oauth-issuer-url>`
- **Workflow:**
  1. Retrieves `client_id` and `client_secret` from 1Password.
  2. Runs `oauth2c` flow.
  3. Saves resulting `access_token` and `refresh_token` back to the 1Password item.

## Development

This project uses Nix flakes.

```bash
# Enter development shell
nix develop

# Build tools
nix build .#safe-op
nix build .#op-oauth2c

# Run tests
./tests/test_safe_op.sh
./tests/test_op_oauth2c.sh
```
