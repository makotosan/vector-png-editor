"""Experimental shared vector-png Editor Core; no complete conformance claim."""
__version__ = "0.1.0.dev1"

from .document import inspect_document, extract_source
from .svg import validate_source

__all__ = ["inspect_document", "extract_source", "validate_source"]
