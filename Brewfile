# What a Mac needs to run Peeblo (docs/SETUP.md, "What you need"). Install with: brew bundle

# Node 24, unless a version manager supplies it from .node-version (nodenv, fnm, mise, asdf) or .nvmrc (nvm).
# node@24 is keg-only; link it over any other node so `node -v` says v24.
# Homebrew strips PATH and most of the environment here, so look for each manager's home directory instead.
version_manager = %w[.nodenv .nvm .local/share/fnm .local/share/mise .asdf].any? { |dir| File.directory?(File.join(Dir.home, dir)) }
brew "node@24", link: :overwrite unless version_manager
brew "pnpm"
# Teammate computers: QEMU runs them, e2fsprogs builds their disk images.
brew "qemu"
brew "e2fsprogs"

# Docker with Compose v2, for Postgres. Either one works; swap the comment to use Docker Desktop.
cask "orbstack"
# cask "docker-desktop"
