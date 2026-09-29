"""Shift-JIS (cp932) handling for fixed-width VMD name fields.

VMD stores names in fixed byte fields (15 bytes for bones and morphs). Long names are
cut at the byte level, which can split a two-byte character. Matching user-supplied
names therefore goes through the same encode → truncate → decode round-trip.
"""

ENCODING = "cp932"
BONE_NAME_BYTES = 15
MODEL_NAME_BYTES = 20


def decode_name(raw: bytes) -> str:
    """Decode a NUL-terminated cp932 field, dropping a dangling half character."""
    data = raw.split(b"\0", 1)[0]
    for end in range(len(data), max(len(data) - 2, -1), -1):
        try:
            return data[:end].decode(ENCODING)
        except UnicodeDecodeError:
            continue
    return data.decode(ENCODING, errors="replace")


def encode_name(name: str, width: int) -> bytes:
    """Encode ``name`` into a NUL-padded ``width``-byte field (truncating like MMD does)."""
    try:
        data = name.encode(ENCODING)
    except UnicodeEncodeError as exc:
        raise ValueError(f"name {name!r} cannot be represented in Shift-JIS (cp932)") from exc
    return data[:width].ljust(width, b"\0")


def canonical_bone_name(name: str) -> str:
    """The name as it would read back from a VMD bone field (for matching)."""
    try:
        return decode_name(encode_name(name, BONE_NAME_BYTES))
    except ValueError:
        return name
