#!/bin/sh
# Downloads the pinned tools for the Debian large image and checks each by sha256. Usage: fetch.sh arm64|amd64
set -eu
ARCH="$1"
T=$(mktemp -d)
get() { # name url sha256
  curl -fsSL --retry 3 -o "$T/$1" "$2"
  echo "$3  $T/$1" | sha256sum -c - >/dev/null || { echo "sha256 mismatch: $1" >&2; exit 1; }
}
GH=https://github.com
if [ "$ARCH" = arm64 ]; then
  get node.tar.xz https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-arm64.tar.xz eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
  get bun.zip $GH/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
  get uv.tgz $GH/astral-sh/uv/releases/download/0.13.7/uv-aarch64-unknown-linux-gnu.tar.gz 71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc
  get typst.txz $GH/typst/typst/releases/download/v0.15.1/typst-aarch64-unknown-linux-musl.tar.xz 5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee
  get ruff.tgz $GH/astral-sh/ruff/releases/download/0.17.4/ruff-aarch64-unknown-linux-gnu.tar.gz b939676db4532f748dc38c41361a29260f18b3e24a787d46d9278e449c25c2cf
  get sg.zip $GH/ast-grep/ast-grep/releases/download/0.51.1/app-aarch64-unknown-linux-gnu.zip db02fae2d8eace5fc40c55242068882452dd03eab38a1d950d5fd981cf112926
  get difft.tgz $GH/Wilfred/difftastic/releases/download/0.72.0/difft-0.72.0-aarch64-unknown-linux-gnu.tar.gz 0993a82a6708a24adc6c6b8de366924728ed08f537a5b488940082c8edc79353
  get duckdb.tgz $GH/duckdb/duckdb/releases/download/v2.0.0/duckdb-cli-linux-arm64.tar.gz 859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe
  get yq $GH/mikefarah/yq/releases/download/v4.54.2/yq_linux_arm64 bd44211dcd29a5f0eb701d4b7eb5ccd0cfff3bd3966cb4f7f9bd5b13701d997e
  get agent-browser $GH/vercel-labs/agent-browser/releases/download/v0.41.2/agent-browser-linux-arm64 00d291f45e1c4d527b3aa08c70c54c7c3030fde0794f8d4575aaa3ca1680f728
  get pyarrow-26.0.1-cp313-cp313-manylinux_2_28_aarch64.whl https://files.pythonhosted.org/packages/31/02/d9462d1ae4e54c3964af38316a802b29c28970b7d375722ef190af736640/pyarrow-26.0.1-cp313-cp313-manylinux_2_28_aarch64.whl a3a79661404ba3d41b7c9a45cb56113246a244b38cb1393fadae289bc66b91b4
  NODE=node-v24.22.2-linux-arm64 BUN=bun-linux-aarch64 UV=uv-aarch64-unknown-linux-gnu TYPST=typst-aarch64-unknown-linux-musl
elif [ "$ARCH" = amd64 ]; then
  get node.tar.xz https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz 48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
  get bun.zip $GH/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
  get uv.tgz $GH/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
  get typst.txz $GH/typst/typst/releases/download/v0.15.1/typst-x86_64-unknown-linux-musl.tar.xz a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
  get ruff.tgz $GH/astral-sh/ruff/releases/download/0.17.4/ruff-x86_64-unknown-linux-gnu.tar.gz 3ab2b34aeacdbc1ea5c529cdbda3e05792633d587228123fd09f3b5a0facb27a
  get sg.zip $GH/ast-grep/ast-grep/releases/download/0.51.1/app-x86_64-unknown-linux-gnu.zip 42514f77ae0c8a25d7d32154d31d3e7e16f3ab894f8ce76ce417de234ee49157
  get difft.tgz $GH/Wilfred/difftastic/releases/download/0.72.0/difft-0.72.0-x86_64-unknown-linux-gnu.tar.gz 33ea1f003081e9f2422299a434e6040c89085bd9f102b08f3fe30393720d5d4a
  get duckdb.tgz $GH/duckdb/duckdb/releases/download/v2.0.0/duckdb-cli-linux-amd64.tar.gz c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc
  get yq $GH/mikefarah/yq/releases/download/v4.54.2/yq_linux_amd64 44c7759059b4910827a0059a2757b22001e59360cdecdb2ef8dedc4b6c7e9f32
  get agent-browser $GH/vercel-labs/agent-browser/releases/download/v0.41.2/agent-browser-linux-x64 c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379
  get pyarrow-26.0.1-cp313-cp313-manylinux_2_28_x86_64.whl https://files.pythonhosted.org/packages/96/54/33c2df56948d88a4d83a52999a4a81a4871b2de481ff25ccd6f5ccd2589a/pyarrow-26.0.1-cp313-cp313-manylinux_2_28_x86_64.whl f71221bbc7707e3fad920d0478db9350791d4714ec445299ee0d56559fbc156c
  NODE=node-v24.22.2-linux-x64 BUN=bun-linux-x64 UV=uv-x86_64-unknown-linux-gnu TYPST=typst-x86_64-unknown-linux-musl
else
  echo "unknown arch $ARCH" >&2; exit 1
fi
get python_pptx-1.0.2-py3-none-any.whl https://files.pythonhosted.org/packages/d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49/python_pptx-1.0.2-py3-none-any.whl 160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba

B=/usr/local/bin
tar -xJf "$T/node.tar.xz" -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
cd "$T"
unzip -q bun.zip && install -m 755 "$BUN/bun" $B/bun && ln -sf bun $B/bunx
tar -xzf uv.tgz && install -m 755 "$UV/uv" "$UV/uvx" $B/
tar -xJf typst.txz && install -m 755 "$TYPST/typst" $B/
tar -xzf ruff.tgz && install -m 755 "$(find . -name ruff -type f | head -1)" $B/ruff
unzip -q sg.zip -d sg && install -m 755 sg/ast-grep $B/ast-grep && ln -sf ast-grep $B/sg
tar -xzf difft.tgz && install -m 755 difft $B/difft
tar -xzf duckdb.tgz && install -m 755 duckdb $B/duckdb
install -m 755 yq $B/yq
install -m 755 agent-browser $B/agent-browser
# Wheels whose dependencies Debian already ships (numpy, lxml, Pillow, XlsxWriter).
pip3 install --no-deps --no-cache-dir --break-system-packages "$T"/*.whl
cd / && rm -rf "$T"
