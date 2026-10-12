"""Offline preflight of the declarative gateway, not a Yandex runtime emulator."""
import copy
import json
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit

import yaml


ROOT = Path(__file__).resolve().parents[1]
SPEC = yaml.safe_load((ROOT / "openapi.yaml").read_text())
FULL = yaml.safe_load((ROOT / "openapi-full.pending.yaml").read_text())
SETTINGS = json.loads((ROOT / "console-settings.json").read_text())
FULL_SETTINGS = json.loads((ROOT / "console-settings-full.pending.json").read_text())
UPSTREAM = "market-api-production-d9ab.up.railway.app"
ALLOWED = {
    "/health": "get",
    "/listings": "get",
    "/listings/{id}": "get",
    "/listings/{id}/photos/{filename}": "get",
}
FULL_ALLOWED = {**ALLOWED, "/submit": "post"}
SITE_ORIGINS = {
    "https://xn----7sbbfg4a6clj5k.xn--p1ai",
    "https://www.xn----7sbbfg4a6clj5k.xn--p1ai",
}


def resolve(value, spec=SPEC):
    if "$ref" not in value:
        return value
    assert value["$ref"].startswith("#/"), "external ref is not allowed"
    resolved = spec
    for key in value["$ref"][2:].split("/"):
        resolved = resolved[key]
    return resolved


def operations(spec):
    for path, path_item in spec["paths"].items():
        for method, operation in path_item.items():
            if method != "parameters":
                yield path, method, operation


def check_safe_spec(spec, full=False):
    """Fail closed if a review adds credentials, a catch-all or a dynamic host."""
    assert spec["openapi"] == "3.0.0"
    assert isinstance(spec["info"]["version"], str)
    allowed = FULL_ALLOWED if full else ALLOWED
    assert set(spec["paths"]) == set(allowed)
    for path, method, operation in operations(spec):
        assert method in {allowed[path], "options"}, "unexpected method"
        integration = resolve(operation["x-yc-apigateway-integration"], spec)
        assert "serviceAccountId" not in integration
        assert "x-yc-schema-mapping" not in operation
        assert "x-yc-apigateway-any-method" not in operation
        assert operation.get("responses"), "missing response definition"
        if method == "options":
            assert integration["type"] == "dummy"
            assert integration["http_code"] == 204
            continue
        if method == "post":
            assert full and path == "/submit"
            assert integration == {
                "type": "cloud_functions",
                "function_id": "FUNCTION_ID",
                "service_account_id": "SERVICE_ACCOUNT_ID",
                "tag": "gateway-submit-reviewed",
                "payload_format_version": "2.0",
            }, "submit must use a private reviewed signer, never direct HTTP"
            continue
        assert integration["type"] == "http"
        upstream_path = "/gateway/photos/{id}/{filename}" if full and path == "/listings/{id}/photos/{filename}" else path
        assert integration["url"] == "https://" + UPSTREAM + upstream_path
        assert integration["method"] == method.upper()
        assert integration["headers"]["Host"] == UPSTREAM
        assert integration["headers"]["Origin"] == "{Origin}"
        assert integration["query"] == {"*": "*"}
        assert integration["omitEmptyHeaders"] is True
        assert set(integration["headers"]) == {"Host", "Origin", "Accept"}, "unreviewed or client-controlled header forwarding"
        assert 0 < integration["timeouts"]["connect"] < 60
        assert 0 < integration["timeouts"]["read"] < 60
    serialized = json.dumps(spec)
    for forbidden in ["{path+}", "Authorization", "Cookie",
                      "X-Forwarded-", "X-Real-IP", '"Forwarded"',
                      "x-yc-apigateway-rate-limit", '"rateLimit"']:
        assert forbidden not in serialized, forbidden
    if not full:
        assert "service_account_id" not in serialized
    assert spec["x-yc-apigateway"]["validator"]["validateRequestParameters"] is True
    assert spec["x-yc-apigateway"]["validator"]["validateRequestBody"] is False
    assert spec["x-yc-apigateway"]["validator"]["validateResponseBody"] is False


class GatewayPreflight(unittest.TestCase):
    def test_fixed_public_upstream_and_methods(self):
        check_safe_spec(SPEC)
        self.assertEqual(len(list(operations(SPEC))), 8)
        self.assertNotIn("/submit", SPEC["paths"])
        for path, method, operation in operations(SPEC):
            if method != "options":
                url = resolve(operation["x-yc-apigateway-integration"])["url"]
                self.assertEqual(urlsplit(url).hostname, UPSTREAM)

    def test_config_drift_to_admin_or_loop_is_rejected(self):
        for path, method, mutation in [
            ("/listings", "get", "admin"),
            ("/health", "get", "loop"),
            ("/listings", "get", "credentials"),
            ("/listings", "get", "forwarded"),
        ]:
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(SPEC)
                integration = bad["paths"][path][method]["x-yc-apigateway-integration"]
                if mutation == "admin":
                    bad["paths"]["/admin/status"] = bad["paths"]["/health"]
                elif mutation == "loop":
                    integration["url"] = "https://market.xn----7sbbfg4a6clj5k.xn--p1ai/health"
                elif mutation == "credentials":
                    integration["headers"]["Authorization"] = "Bearer synthetic-test-only"
                else:
                    integration["headers"]["*"] = "*"
                with self.assertRaises(AssertionError):
                    check_safe_spec(bad)

    def test_cors_is_exact_public_site_without_credentials(self):
        cors = SPEC["x-yc-apigateway"]["cors"]
        self.assertEqual(set(cors["origin"]), SITE_ORIGINS)
        self.assertEqual(set(cors["methods"]), {"GET", "OPTIONS"})
        self.assertEqual(cors["allowedHeaders"], ["Content-Type"])
        self.assertEqual(set(cors["exposedHeaders"]), {"Retry-After", "X-Request-Id"})
        self.assertIs(cors["credentials"], False)
        self.assertEqual(cors["optionsSuccessStatus"], 204)
        self.assertEqual(set(SPEC["components"]["parameters"]["Origin"]["schema"]["enum"]), SITE_ORIGINS)
        self.assertEqual(set(FULL["x-yc-apigateway"]["cors"]["methods"]), {"GET", "POST", "OPTIONS"})
        self.assertIs(FULL["x-yc-apigateway"]["cors"]["credentials"], False)

    def test_multipart_boundary_and_retry_key_are_preserved_by_configuration(self):
        operation = FULL["paths"]["/submit"]["post"]
        integration = operation["x-yc-apigateway-integration"]
        self.assertEqual(integration["payload_format_version"], "2.0")
        self.assertNotIn("headers", integration)
        header = FULL["components"]["parameters"]["MultipartContentType"]
        self.assertTrue(header["required"])
        content_type = "multipart/form-data; boundary=----synthetic_boundary_123"
        self.assertRegex(content_type, header["schema"]["pattern"])
        self.assertNotRegex("multipart/form-data", header["schema"]["pattern"])
        body = operation["requestBody"]["content"]["multipart/form-data"]["schema"]
        self.assertIn("requestId", body["properties"])
        self.assertTrue(body["additionalProperties"])

    def test_pending_submit_cannot_fall_back_to_direct_http_or_public_function(self):
        check_safe_spec(FULL, full=True)
        self.assertEqual(len(list(operations(FULL))), 10)
        for mutation in ["http", "unauthenticated", "latest"]:
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(FULL)
                integration = bad["paths"]["/submit"]["post"]["x-yc-apigateway-integration"]
                if mutation == "http":
                    integration.clear()
                    integration.update(type="http", url="https://" + UPSTREAM + "/submit")
                elif mutation == "unauthenticated":
                    del integration["service_account_id"]
                else:
                    integration["tag"] = "$latest"
                with self.assertRaises(AssertionError):
                    check_safe_spec(bad, full=True)
        self.assertIs(FULL_SETTINGS["function"]["publicInvocation"], False)
        self.assertEqual(FULL_SETTINGS["function"]["invokerRole"], "functions.functionInvoker")
        self.assertEqual(FULL_SETTINGS["function"]["roleScope"], "signer function only")
        self.assertIs(FULL_SETTINGS["loggingEnabled"], False)
        self.assertIs(FULL_SETTINGS["productionDnsChange"], False)

    def test_path_parameters_cannot_escape_fixed_routes(self):
        schemas = SPEC["components"]["parameters"]
        safe_id = "2026-10-07T09-12-13-123Z_abcdef12"
        self.assertRegex(safe_id, schemas["ListingId"]["schema"]["pattern"])
        self.assertRegex("photo-01.jpg", schemas["PhotoFilename"]["schema"]["pattern"])
        for value in ["../admin", "..", "a/b.jpg", "%2fadmin", "a%2fb.jpg", "https://evil.example/photo.jpg", "photo.jpg?next=/admin"]:
            for name in ["ListingId", "PhotoFilename"]:
                with self.subTest(value=value, name=name):
                    self.assertIsNone(re.fullmatch(schemas[name]["schema"]["pattern"], value))
        for path, path_item in SPEC["paths"].items():
            path_params = [resolve(p) for p in path_item.get("parameters", [])]
            self.assertEqual({p["name"] for p in path_params}, set(re.findall(r"\{([^}]+)\}", path)))
            self.assertTrue(all(p["in"] == "path" and p["required"] for p in path_params))

    def test_preflights_never_invoke_railway(self):
        for path_item in SPEC["paths"].values():
            integration = resolve(path_item["options"]["x-yc-apigateway-integration"])
            self.assertEqual(integration["type"], "dummy")
            self.assertNotIn("url", integration)

    def test_resource_settings_are_test_only_without_logging_or_extra_services(self):
        self.assertEqual(SETTINGS["region"], "Russia")
        self.assertTrue(SETTINGS["name"].endswith("-test"))
        self.assertEqual(SETTINGS["executionTimeoutSeconds"], 60)
        self.assertIs(SETTINGS["loggingEnabled"], False)
        self.assertIsNone(SETTINGS["serviceAccount"])
        self.assertIsNone(SETTINGS["userNetwork"])
        self.assertIsNone(SETTINGS["customDomain"])
        self.assertIs(SETTINGS["productionDnsChange"], False)


if __name__ == "__main__":
    unittest.main()
