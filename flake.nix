{
  description = "Spool — search and share your AI coding sessions";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          inherit (pkgs)
            copyDesktopItems
            fetchPnpmDeps
            lib
            libcap
            libglvnd
            makeDesktopItem
            makeWrapper
            nodejs_22
            openssl
            patchelf
            pkg-config
            pnpm_10
            pnpmConfigHook
            python3
            stdenv
            writableTmpDirAsHomeHook
            xdg-terminal-exec
            xz
            zlib
            ;

          version = packageJson.version;
          src = lib.cleanSource self;
          electron = pkgs.electron;

          # ── CLI ──────────────────────────────────────────────────────

          cliPnpmWorkspaces = [
            "@spool-lab/cli"
            "@spool-lab/core"
            "@spool-lab/redact"
          ];

          spool-cli = stdenv.mkDerivation {
            pname = "spool";
            inherit version src;
            pnpmWorkspaces = cliPnpmWorkspaces;

            pnpmDeps = fetchPnpmDeps {
              pname = "spool";
              inherit version src;
              pnpmWorkspaces = cliPnpmWorkspaces;
              pnpm = pnpm_10;
              fetcherVersion = 3;
              hash = "sha256-PIiP+YP0JF7ovpT7svKDwEGazp5/KwQ3LVlCMoGPedI=";
            };

            nativeBuildInputs = [
              makeWrapper
              nodejs_22
              patchelf
              pkg-config
              pnpm_10
              pnpmConfigHook
              python3
              writableTmpDirAsHomeHook
            ];

            buildInputs = [ stdenv.cc.cc.lib ];

            env = {
              npm_config_build_from_source = "true";
              npm_config_fallback_to_build = "true";
            };

            dontNpmInstall = true;

            buildPhase = ''
              runHook preBuild

              export COREPACK_ENABLE_PROJECT_SPEC=0
              export npm_config_manage_package_manager_versions=false
              export npm_config_nodedir=${nodejs_22}

              for betterSqlite in $(find . -path '*/node_modules/better-sqlite3' -type d); do
                (
                  cd "$betterSqlite"
                  npm run build-release --offline
                  rm -rf build/Release/{.deps,obj,obj.target,test_extension.node}
                )
              done

              pnpm --filter @spool-lab/redact run build
              pnpm --filter @spool-lab/core run build
              pnpm --filter @spool-lab/cli run build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/spool
              cp -R node_modules $out/lib/spool/node_modules

              mkdir -p $out/lib/spool/packages/cli
              cp -R packages/cli/dist $out/lib/spool/packages/cli/dist
              cp -R packages/cli/bin $out/lib/spool/packages/cli/bin
              cp packages/cli/package.json $out/lib/spool/packages/cli/package.json
              cp -R packages/cli/node_modules $out/lib/spool/packages/cli/node_modules

              mkdir -p $out/lib/spool/packages/core
              cp -R packages/core/dist $out/lib/spool/packages/core/dist
              cp packages/core/package.json $out/lib/spool/packages/core/package.json
              cp -R packages/core/node_modules $out/lib/spool/packages/core/node_modules
              mkdir -p $out/lib/spool/packages/redact
              cp -R packages/redact/dist $out/lib/spool/packages/redact/dist
              cp packages/redact/package.json $out/lib/spool/packages/redact/package.json
              cp -R packages/redact/node_modules $out/lib/spool/packages/redact/node_modules

              for addon in $(find $out/lib/spool -name 'better_sqlite3.node' -type f); do
                patchelf \
                  --set-rpath "${lib.makeLibraryPath [ stdenv.cc.cc.lib ]}" \
                  "$addon" || true
              done

              chmod +x $out/lib/spool/packages/cli/bin/spool.js

              makeWrapper ${lib.getExe nodejs_22} "$out/bin/spool" \
                --add-flags "$out/lib/spool/packages/cli/bin/spool.js" \
                --prefix PATH : ${lib.makeBinPath [ nodejs_22 ]}

              # Install the SKILL.md so home-manager can symlink it into
              # ~/.agents/skills/spool/ — tracked by the Nix store.
              install -Dm644 skills/spool/SKILL.md $out/share/skills/spool/SKILL.md

              runHook postInstall
            '';

            meta = {
              description = "CLI for searching your local AI coding sessions";
              homepage = "https://github.com/spool-lab/spool";
              changelog = "https://github.com/spool-lab/spool/releases/tag/v${version}";
              license = lib.licenses.mit;
              mainProgram = "spool";
              maintainers = with lib.maintainers; [ ];
              platforms = lib.platforms.unix;
              sourceProvenance = with lib.sourceTypes; [
                fromSource
                binaryNativeCode
              ];
            };
          };

          # ── GUI App ──────────────────────────────────────────────────

          appPnpmWorkspaces = [
            "@spool/app"
            "@spool-lab/core"
            "@spool-lab/redact"
            "@spool/share-kit"
          ];

          desktopItem = makeDesktopItem {
            name = "spool";
            exec = "spool-app %U";
            icon = "spool";
            desktopName = "Spool";
            comment = "Desktop app for searching and sharing AI coding sessions";
            categories = [
              "Development"
              "Utility"
            ];
            startupWMClass = "Spool";
          };

          runtimePath = lib.makeBinPath [ xdg-terminal-exec ];
          electronRuntimeLibPath = lib.makeLibraryPath [ libglvnd ];
          acpCodexLibPath = lib.makeLibraryPath [
            libcap
            openssl
            stdenv.cc.cc.lib
            stdenv.cc.libc
            xz
            zlib
          ];

          spool-app = stdenv.mkDerivation {
            pname = "spool-app";
            inherit version src;
            pnpmWorkspaces = appPnpmWorkspaces;

            pnpmDeps = fetchPnpmDeps {
              pname = "spool-app";
              inherit version src;
              pnpmWorkspaces = appPnpmWorkspaces;
              pnpm = pnpm_10;
              fetcherVersion = 3;
              hash = "sha256-3PyPZ2If/+MwqOX2HbwkZGIujMPyoRoUeo0UbbpVOeY=";
            };

            nativeBuildInputs = [
              copyDesktopItems
              makeWrapper
              nodejs_22
              patchelf
              pkg-config
              pnpm_10
              pnpmConfigHook
              python3
              writableTmpDirAsHomeHook
            ];

            env = {
              ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
              npm_config_build_from_source = "true";
              npm_config_fallback_to_build = "true";
            };

            dontNpmInstall = true;

            buildPhase = ''
              runHook preBuild

              export COREPACK_ENABLE_PROJECT_SPEC=0
              export npm_config_manage_package_manager_versions=false
              export npm_config_disturl=https://electronjs.org/headers
              export npm_config_nodedir=${electron.headers}
              export npm_config_runtime=electron
              export npm_config_target=${electron.version}

              for betterSqlite in $(find . -path '*/node_modules/better-sqlite3' -type d); do
                (
                  cd "$betterSqlite"
                  npm run build-release --offline --nodedir=${electron.headers}
                  rm -rf build/Release/{.deps,obj,obj.target,test_extension.node}
                )
              done

              pnpm --filter @spool/app run build:electron
              pnpm --filter @spool/app exec electron-builder \
                --dir \
                --linux \
                --publish never \
                -c.asar=false \
                -c.electronDist=${electron.dist} \
                -c.electronVersion=${electron.version} \
                -c.npmRebuild=false

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/spool
              cp -R packages/app/dist/linux-unpacked/. $out/share/spool/

              patchelf \
                --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" \
                --set-rpath "${acpCodexLibPath}" \
                $out/share/spool/resources/app/node_modules/acp-extension-codex-linux-x64/bin/acp-extension-codex

              makeWrapper "$out/share/spool/@spoolapp" "$out/bin/spool-app" \
                --add-flags "--no-sandbox" \
                --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}" \
                --prefix PATH : "${runtimePath}" \
                --prefix LD_LIBRARY_PATH : "${electronRuntimeLibPath}" \
                --inherit-argv0

              install -Dm644 packages/app/resources/icon.png $out/share/icons/hicolor/512x512/apps/spool.png

              runHook postInstall
            '';

            desktopItems = [ desktopItem ];

            meta = {
              description = "Desktop app for searching and sharing AI coding sessions";
              homepage = "https://github.com/spool-lab/spool";
              changelog = "https://github.com/spool-lab/spool/releases/tag/v${version}";
              license = lib.licenses.mit;
              mainProgram = "spool-app";
              maintainers = with lib.maintainers; [ ];
              platforms = supportedSystems;
              sourceProvenance = with lib.sourceTypes; [
                fromSource
                binaryNativeCode
              ];
            };
          };
        in
        {
          default = spool-cli;
          spool = spool-cli;
          cli = spool-cli;
          app = spool-app;
          spool-app = spool-app;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/spool";
        };
        cli = {
          type = "app";
          program = "${self.packages.${system}.spool-cli or self.packages.${system}.cli}/bin/spool";
        };
        app = {
          type = "app";
          program = "${self.packages.${system}.app}/bin/spool-app";
        };
      });
    };
}
