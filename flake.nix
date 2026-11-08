{
  description = "Development shell for mineflayer-prometheus";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) isLinux;
        in
        {
          # mkShell brings the C/C++ toolchain and make of stdenv for node-gyp
          default = pkgs.mkShell (
            {
              packages =
                with pkgs;
                [
                  nodejs_24
                  pkg-config
                  python3

                  # native libraries of the optional canvas peer dependency, for building it from source
                  cairo
                  pango
                  libjpeg
                  giflib
                  librsvg
                  pixman
                ]
                # node-canvas-webgl's gl has no Node 24 prebuild, so it builds against the GL and X headers,
                # and it needs an X display at runtime (xvfb-run)
                ++ lib.optionals isLinux [
                  libGL
                  libGLU
                  libx11
                  libxi
                  libxext
                  mesa-demos
                  xvfb-run
                ];

              # fontconfig from nixpkgs has no default config outside NixOS, which a canvas built from source uses
              FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
            }
            // lib.optionalAttrs isLinux {
              # The prebuilt canvas bundles its libraries next to canvas.node, except libuuid. Binaries
              # built in the shell get an rpath, but gl loads libGL with dlopen, and libglvnd and Xvfb
              # look for Mesa in /run/opengl-driver, which only exists on NixOS.
              LD_LIBRARY_PATH = lib.makeLibraryPath [
                pkgs.libuuid
                pkgs.libGL
                pkgs.mesa
              ];
              LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
            }
          );
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
