"""
Проверка подписи приложения внутри DMG.

Образ — это сжатый UDIF. Внутри лежит HFS+ том с puuush.app, и подпись
(ad-hoc или Developer ID) лежит в нём же, в Contents/_CodeSignature.

Проверка нужна потому, что сборка проходит успешно и без подписи: файл
получается, macOS его открывает, а запустить приложение не может — ядро на
Apple silicon требует подпись, и macOS называет это «приложение повреждено».

    python3 scripts/check-dmg-signature.py файл.dmg
"""
import struct
import sys
import zlib


def read_trailer(data):
    idx = data.rfind(b'koly')
    if idx < 0 or len(data) - idx != 512:
        raise SystemExit('в конце файла нет трейлера UDIF')
    t = data[idx:idx + 512]
    df_off, df_len = struct.unpack('>QQ', t[24:40])
    return idx, df_off, df_len


def scan(data, df_off, df_len):
    """Ищет следы подписи в распакованных данных образа."""
    found = set()
    decompressor = zlib.decompressobj()
    offset = df_off
    end = df_off + df_len
    chunk = 1 << 20
    while offset < end:
        piece = data[offset:min(offset + chunk, end)]
        if not piece:
            break
        try:
            out = decompressor.decompress(piece)
        except zlib.error:
            break
        offset += len(piece)
        for needle, name in (
            (b'Contents/_CodeSignature', 'подпись приложения'),
            (b'puuush.app/Contents', 'само приложение'),
            (b'com.apple.application-identity', 'подпись Developer ID'),
        ):
            if needle in out:
                found.add(name)
        if len(found) >= 2:
            break
    return found


def main(path):
    data = open(path, 'rb').read()
    _, df_off, df_len = read_trailer(data)
    found = scan(data, df_off, df_len)
    print(f'  {path}: {", ".join(sorted(found)) or "подпись не найдена"}')
    return 0 if 'подпись приложения' in found else 1


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('usage: check-dmg-signature.py <dmg>')
    sys.exit(main(sys.argv[1]))
