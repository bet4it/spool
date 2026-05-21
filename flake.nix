{
  description = "Spool desktop app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

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

          pname = "spool";
          version = packageJson.version;
          electron = pkgs.electron_39;
          src = lib.cleanSource self;

          acpCodexLibPath = lib.makeLibraryPath [
            libcap
            openssl
            stdenv.cc.cc.lib
            stdenv.cc.libc
            xz
            zlib
          ];

          electronRuntimeLibPath = lib.makeLibraryPath [
            libglvnd
          ];

          runtimePath = lib.makeBinPath [
            xdg-terminal-exec
          ];

          pnpmWorkspaces = [
            "@spool/app"
            "@spool-lab/core"
            "@spool-lab/redact"
            "@spool/share-kit"
          ];

          betterSqlitePatch = ''
            substituteInPlace packages/app/package.json packages/core/package.json \
              --replace-fail '"better-sqlite3": "^11.10.0"' '"better-sqlite3": "^12.9.0"'

            substituteInPlace pnpm-lock.yaml \
              --replace-fail 'specifier: ^11.10.0' 'specifier: ^12.9.0' \
              --replace-fail 'version: 11.10.0' 'version: 12.9.0'
          '';

          desktopItem = makeDesktopItem {
            name = "spool";
            exec = "spool %U";
            icon = "spool";
            desktopName = "Spool";
            comment = "Desktop app for searching and sharing AI coding sessions";
            categories = [
              "Development"
              "Utility"
            ];
            startupWMClass = "Spool";
          };

          spool = stdenv.mkDerivation {
            inherit
              pname
              version
              src
              pnpmWorkspaces
              ;

            pnpmDeps = fetchPnpmDeps {
              inherit
                pname
                version
                src
                pnpmWorkspaces
                ;
              pnpm = pnpm_10;
              postPatch = betterSqlitePatch;
              fetcherVersion = 3;
              hash = "sha256-rSiKs9HZN2MXOOrtIKvuQ0xEUCzNdh9dTQuc1Cp+oSo=";
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

            postPatch = ''
              substituteInPlace package.json \
                --replace-fail '"packageManager": "pnpm@10.33.0"' '"packageManager": "pnpm@${pnpm_10.version}"'

              ${betterSqlitePatch}
            '';

            buildPhase = ''
              runHook preBuild

              export HOME=$TMPDIR
              export npm_config_nodedir=${electron.headers}
              export npm_config_target=${electron.version}
              export npm_config_runtime=electron
              export npm_config_disturl=https://electronjs.org/headers
              export npm_config_manage_package_manager_versions=false
              export COREPACK_ENABLE_PROJECT_SPEC=0

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

              mkdir -p $out/share/spool $out/bin
              cp -R packages/app/dist/linux-unpacked/. $out/share/spool/

              patchelf \
                --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" \
                --set-rpath "${acpCodexLibPath}" \
                $out/share/spool/resources/app/node_modules/acp-extension-codex-linux-x64/bin/acp-extension-codex

              appExe=$out/share/spool/@spoolapp

              makeWrapper "$appExe" $out/bin/spool \
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
              mainProgram = "spool";
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
          default = spool;
          spool = spool;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/spool";
        };
        spool = {
          type = "app";
          program = "${self.packages.${system}.spool}/bin/spool";
        };
      });
    };
}
