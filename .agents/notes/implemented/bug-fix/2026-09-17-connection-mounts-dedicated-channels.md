# Agent Note: Connection mounts dedicated RPC channels on its own carrier

Status: implemented

English | [中文](2026-09-17-connection-mounts-dedicated-channels.zh.md)

## Problem

`connection.rpc.handle(channel, handler)` registered its physical route through the caller's context: `owner.webServer.register(route)`. Under the strict-inject Context proxy, reading `ctx.webServer` from a fiber whose `inject` does not name `webServer` throws `cannot get property "webServer" without inject`. The `rpc.handle` contract documented only `connection` as the registrant's dependency, so a plugin written to that contract failed at load. Two external plugins in the production Web profile failed this way after Connection's own `inject` moved from `['webServer']` to `['credentials']`, and one such failure fails the whole Loader tree.

## Decision

`HostConnectionService` keeps the registered channels itself and mounts each one on a Web carrier that Connection attaches inside its own `ctx.inject(['webServer'], …)` block, beside the shared `/api` route. A registrant's fiber owns only the registration effect: disposing the registrant removes the channel; a duplicate channel name throws at registration. A channel registered before a carrier exists mounts when one arrives, and detaching the carrier unmounts every channel while keeping the registrations, so the next carrier serves them again.

The `rpc.handle` JSDoc, the package README, and a REAL-composition spec (`tests/dedicated-channel.host.spec.ts`: a Loader-booted `cordis.yml` whose registrant injects only `connection`, exercised over the running HTTP server) pin the contract. The spec fails on the previous implementation with the registrant fiber in the failed state.

## Alternatives considered

**Require `webServer` in every registrant's `inject`.** This fixes each plugin separately, leaves the documented contract wrong, and still couples a channel's lifetime to a carrier the registrant does not own: a registrant that outlives a carrier replacement keeps a stale route.

**Read `webServer` through `ctx.get('webServer')` at the call site.** The optional read avoids the proxy error but silently registers nothing when the carrier is absent or arrives later, which is the "route missing without diagnosis" failure the production incident showed.

**Mount channels through the shared `/api` interceptor.** Dedicated channels exist precisely so a plugin can own a prefix without competing for the single `/api` interceptor seat; folding them in changes the wire paths external plugins already use.

## Consequences

Registrants inject only `connection`, matching the documented contract and the existing `fetch.register` behavior. Channel mounting follows the carrier's lifetime, so a Web server replacement during HMR re-serves every registered channel. The [transport layering note](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) remains the authority for which package owns which route; this note only moves the physical mount of dedicated channels from the registrant's context to Connection's carrier.
