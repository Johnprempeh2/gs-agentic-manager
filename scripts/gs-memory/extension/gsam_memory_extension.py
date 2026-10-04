"""Greatstone extension for Hindsight v0.10.2 (GRE-672, ADR-0001).

Load it in the engine environment:
    PYTHONPATH=<repo>/scripts/gs-memory/extension
    HINDSIGHT_API_TENANT_EXTENSION=gsam_memory_extension:GsamTenantExtension
    HINDSIGHT_API_TENANT_API_KEY=<gateway key>
    HINDSIGHT_API_TENANT_ASSERTION_SECRET=<assertion secret>
    HINDSIGHT_API_OPERATION_VALIDATOR_EXTENSION=gsam_memory_extension:GsamOperationValidator
    HINDSIGHT_API_OPERATION_VALIDATOR_ASSERTION_SECRET=<assertion secret>
    HINDSIGHT_API_EXTENSION_PASSTHROUGH_HEADERS=x-gsam-memory-assertion

Every HTTP call needs the gateway key and a valid assertion. The assertion
names one bank and the tags the GSAM gateway allowed. Each operation is checked
against it. Anything the gateway never does is refused: reflect, mental models,
consolidation, bank reads, bank delete, clear, export and aliases. So a leaked
key, or a known bank id, reaches nothing on its own.
"""

from __future__ import annotations

import hmac

from hindsight_api.config import get_config
from hindsight_api.extensions import (
    AuthenticationError,
    BankListContext,
    BankListResult,
    BankReadContext,
    BankReadOperation,
    BankWriteContext,
    BankWriteOperation,
    ConsolidateContext,
    CreateBankContext,
    MemoryUpdateContext,
    MentalModelGetContext,
    MentalModelRefreshContext,
    OperationValidatorExtension,
    PrecheckContext,
    PrecheckOperation,
    RecallContext,
    ReflectContext,
    RequestContext,
    RetainContext,
    Tenant,
    TenantContext,
    TenantExtension,
    ValidationResult,
)

from gsam_memory_assertion import HEADER, AssertionError_, Claims, verify


def _claims(request_context: RequestContext, secret: str) -> Claims:
    headers = getattr(request_context, "extra_headers", None) or {}
    return verify(headers.get(HEADER), secret)


class GsamTenantExtension(TenantExtension):
    def __init__(self, config: dict[str, str]):
        super().__init__(config)
        self.api_key = config.get("api_key") or ""
        self.assertion_secret = config.get("assertion_secret") or ""
        if not self.api_key or not self.assertion_secret:
            raise ValueError("HINDSIGHT_API_TENANT_API_KEY and HINDSIGHT_API_TENANT_ASSERTION_SECRET are required")

    async def authenticate(self, context: RequestContext) -> TenantContext:
        if not context.api_key or not hmac.compare_digest(context.api_key, self.api_key):
            raise AuthenticationError("Invalid API key")
        try:
            _claims(context, self.assertion_secret)
        except AssertionError_ as exc:
            raise AuthenticationError(f"GSAM gateway assertion required: {exc}") from exc
        return TenantContext(schema_name=get_config().database_schema)

    async def authenticate_mcp(self, context: RequestContext) -> TenantContext:
        # The engine's MCP server is off; refuse it even if someone turns it on.
        raise AuthenticationError("MCP is not available on this engine")

    async def list_tenants(self) -> list[Tenant]:
        return [Tenant(schema=get_config().database_schema)]


class GsamOperationValidator(OperationValidatorExtension):
    def __init__(self, config: dict[str, str]):
        super().__init__(config)
        self.assertion_secret = config.get("assertion_secret") or ""
        if not self.assertion_secret:
            raise ValueError("HINDSIGHT_API_OPERATION_VALIDATOR_ASSERTION_SECRET is required")

    def _check(self, request_context: RequestContext, op: str | set[str], bank_id: str) -> Claims | ValidationResult:
        # The engine's own background work carries no HTTP headers.
        if getattr(request_context, "internal", False):
            return Claims(op="internal", bank=bank_id, read=(), write=(), doc=None, exp=0)
        try:
            claims = _claims(request_context, self.assertion_secret)
        except AssertionError_ as exc:
            return ValidationResult.reject(f"GSAM gateway assertion required: {exc}", 401)
        allowed = {op} if isinstance(op, str) else op
        if claims.op not in allowed:
            return ValidationResult.reject("Operation not allowed by the gateway assertion")
        if claims.bank != bank_id:
            return ValidationResult.reject("Bank not allowed by the gateway assertion")
        return claims

    async def precheck(self, ctx: PrecheckContext) -> ValidationResult:
        wanted = {PrecheckOperation.RETAIN: "retain", PrecheckOperation.RECALL: "recall"}.get(ctx.operation)
        if wanted is None:
            return ValidationResult.reject("Operation is not available through the GSAM gateway")
        result = self._check(ctx.request_context, wanted, ctx.bank_id)
        return result if isinstance(result, ValidationResult) else ValidationResult.accept()

    async def validate_retain(self, ctx: RetainContext) -> ValidationResult:
        claims = self._check(ctx.request_context, "retain", ctx.bank_id)
        if isinstance(claims, ValidationResult):
            return claims
        if claims.op == "internal":
            return ValidationResult.accept()
        if ctx.attachments:
            return ValidationResult.reject("Attachments are not accepted")
        allowed_tags = set(claims.write)
        for item in ctx.contents:
            tags = item.get("tags") or []
            if not tags or not set(tags) <= allowed_tags:
                return ValidationResult.reject("Document tags not allowed by the gateway assertion")
            if claims.doc is not None and item.get("document_id") != claims.doc:
                return ValidationResult.reject("Document id not allowed by the gateway assertion")
        return ValidationResult.accept()

    async def validate_recall(self, ctx: RecallContext) -> ValidationResult:
        claims = self._check(ctx.request_context, "recall", ctx.bank_id)
        if isinstance(claims, ValidationResult):
            return claims
        if claims.op == "internal":
            return ValidationResult.accept()
        if ctx.tag_groups:
            return ValidationResult.reject("tag_groups are not accepted")
        if not claims.read:
            return ValidationResult.reject("Assertion allows no scope")
        # Whatever the caller asked for, only the signed scopes are searched,
        # and untagged documents never match.
        return ValidationResult.accept_with(tags=list(claims.read), tags_match="any_strict")

    async def validate_create_bank(self, ctx: CreateBankContext) -> ValidationResult:
        result = self._check(ctx.request_context, {"retain", "configure"}, ctx.bank_id)
        return result if isinstance(result, ValidationResult) else ValidationResult.accept()

    async def validate_bank_write(self, ctx: BankWriteContext) -> ValidationResult:
        needed = {
            BankWriteOperation.DELETE_DOCUMENT: "delete",
            BankWriteOperation.UPDATE_BANK_CONFIG: "configure",
            BankWriteOperation.UPDATE_BANK: "configure",
        }.get(ctx.operation)
        if needed is None:
            if getattr(ctx.request_context, "internal", False):
                return ValidationResult.accept()
            return ValidationResult.reject("Operation is not available through the GSAM gateway")
        result = self._check(ctx.request_context, needed, ctx.bank_id)
        return result if isinstance(result, ValidationResult) else ValidationResult.accept()

    async def validate_bank_read(self, ctx: BankReadContext) -> ValidationResult:
        if getattr(ctx.request_context, "internal", False):
            return ValidationResult.accept()
        # Retain, recall and bank updates load the bank profile (name and
        # settings, no memory content) on the caller's behalf. Allow that one
        # read for the signed bank; refuse every other read.
        if ctx.operation == BankReadOperation.GET_BANK_PROFILE:
            result = self._check(ctx.request_context, {"retain", "recall", "configure", "delete"}, ctx.bank_id)
            return result if isinstance(result, ValidationResult) else ValidationResult.accept()
        return ValidationResult.reject("Bank reads are not available through the GSAM gateway")

    async def filter_bank_list(self, ctx: BankListContext) -> BankListResult:
        return BankListResult(banks=[])

    async def validate_reflect(self, ctx: ReflectContext) -> ValidationResult:
        return ValidationResult.reject("Reflect is off in the memory MVP")

    async def validate_consolidate(self, ctx: ConsolidateContext) -> ValidationResult:
        if getattr(ctx.request_context, "internal", False):
            return ValidationResult.accept()
        return ValidationResult.reject("Consolidation is off in the memory MVP")

    async def validate_memory_update(self, ctx: MemoryUpdateContext) -> ValidationResult:
        return ValidationResult.reject("Memory edits go through the GSAM gateway")

    async def validate_mental_model_get(self, ctx: MentalModelGetContext) -> ValidationResult:
        return ValidationResult.reject("Mental models are off in the memory MVP")

    async def validate_mental_model_refresh(self, ctx: MentalModelRefreshContext) -> ValidationResult:
        return ValidationResult.reject("Mental models are off in the memory MVP")
