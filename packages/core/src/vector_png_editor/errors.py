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
}


class CoreError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)
