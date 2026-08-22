{ mkShell
, nodejs_24
, ...
}:

# Dev shell for tools/mcp-workers. wrangler comes from the workspace's own
# devDependencies (npx wrangler / the npm run deploy:* scripts), so the only
# ambient requirement is node itself, matching the pinned check toolchain.
mkShell {
  packages = [ nodejs_24 ];

  shellHook = ''
    echo "mcp-workers: cd tools/mcp-workers; npm install; npm run typecheck; npm test"
  '';
}
