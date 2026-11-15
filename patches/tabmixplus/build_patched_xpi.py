"""Tab Mix Plus のリリース XPI に、このフォルダの fix_*.patch を当てて再パックする。

usage: python -I build_patched_xpi.py <tab_mix_plus-x.y.z.xpi> [出力先.xpi]

パッチは upstream リポジトリ(onemen/TabMixPlus)の `addon/` 配下を基準にした
git 形式の差分。XPI の中身は `addon/` 直下に相当するので `-p2` で当てる。
出力先を省略すると `dist/<元のファイル名>` に `-floorp-fix` を付けて書き出す。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def log(msg: str) -> None:
    print(f"[build_patched_xpi] {msg}", file=sys.stderr)


def apply_patches(work_dir: Path, patches: list[Path]) -> None:
    for patch in patches:
        # 単体で当たるかを先に確認し、失敗時はどのパッチが原因かをログに残す
        for args in (["--check"], []):
            result = subprocess.run(
                ["git", "apply", "-p2", "--whitespace=nowarn", *args, str(patch)],
                cwd=work_dir, capture_output=True, text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"{patch.name} を適用できません:\n{result.stderr.strip()}")
        log(f"applied {patch.name}")


def repack(src_xpi: Path, work_dir: Path, out_xpi: Path) -> None:
    # 元の XPI と同じエントリ順・圧縮方式で詰め直す(未署名なので META-INF は無い)
    with zipfile.ZipFile(src_xpi) as src, zipfile.ZipFile(out_xpi, "w") as dst:
        for info in src.infolist():
            if info.is_dir():
                dst.writestr(info, b"")
                continue
            data = (work_dir / info.filename).read_bytes()
            dst.writestr(info, data, compress_type=info.compress_type)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    src_xpi = Path(argv[1]).resolve()
    out_xpi = (
        Path(argv[2]).resolve() if len(argv) > 2
        else HERE / "dist" / f"{src_xpi.stem}-floorp-fix.xpi"
    )
    patches = sorted(HERE.glob("fix_*.patch"))
    if not patches:
        log(f"パッチが見つかりません: {HERE}")
        return 1

    work_dir = Path(tempfile.mkdtemp(prefix="tmp-xpi-"))
    try:
        with zipfile.ZipFile(src_xpi) as z:
            if any(n.startswith("META-INF/") for n in z.namelist()):
                # 署名付き XPI を書き換えると署名が壊れるため対象外にする
                log("署名付き XPI には対応していません")
                return 1
            z.extractall(work_dir)
        apply_patches(work_dir, patches)
        out_xpi.parent.mkdir(parents=True, exist_ok=True)
        repack(src_xpi, work_dir, out_xpi)
        log(f"wrote {out_xpi}")
        return 0
    except (OSError, zipfile.BadZipFile, RuntimeError) as ex:
        log(f"失敗しました: {ex}")
        return 1
    finally:
        # 作業用の一時展開フォルダ(このスクリプト自身が作ったもの)を片付ける
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
