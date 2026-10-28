"""Machine-readable failures shared by the Core and CLI."""

EXIT_CODES = {
    "invalid-arguments": 2,
    "invalid-container": 3,
    "invalid-svg": 4,
    "unsupported-profile": 5,
    "resource-limit": 6,
    "ordinary-png": 7,
    "io-error": 8,
    "output-exists": 9,
    "render-failed": 10,
    "render-timeout": 11,
    "render-mismatch": 12,
    "conflict": 13,
    "cancelled": 14,
    # svg-normalization-v1 report failure codes (profile section 7),
    # mapped onto the existing exit-code ranges.
    "invalid-xml": 4,
    "unsafe-input": 4,
    "unsupported-css": 5,
    "invalid-reference": 5,
    "output-alias": 9,
    "render-error": 10,
}


class CoreError(ValueError):
    def __init__(self, code, message, details=None):
        self.code = code
        self.details = details
        super().__init__(message)
