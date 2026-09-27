import { describe, it, expect } from "vitest";
import { isPrivateIp, hostAllowed } from "../../src/domain/ssrf.js";

describe("isPrivateIp", () => {
  it("flags loopback", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });
  it("flags private v4 ranges", () => {
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("172.16.0.5")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });
  it("flags link-local including the ECS/EC2 metadata addresses", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("169.254.170.2")).toBe(true);
  });
  it("flags CGNAT", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });
  it("flags v6 loopback and ULA", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
  });
  it("allows a public v4 address", () => {
    expect(isPrivateIp("157.240.2.35")).toBe(false);
  });
});

describe("hostAllowed", () => {
  const allowlist = ["*.cdninstagram.com", "*.fbcdn.net"];
  it("allows a matching subdomain", () => {
    expect(hostAllowed("scontent.cdninstagram.com", allowlist)).toBe(true);
    expect(hostAllowed("video.fbcdn.net", allowlist)).toBe(true);
  });
  it("rejects a non-matching host", () => {
    expect(hostAllowed("evil.example.com", allowlist)).toBe(false);
  });
  it("rejects a host that merely contains the suffix without the dot boundary", () => {
    expect(hostAllowed("notcdninstagram.com", allowlist)).toBe(false);
  });
});
