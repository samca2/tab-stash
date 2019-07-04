"use strict";

// Front-end to a cache provided by cache-service.ts.  For a complete design
// description, see cache-service.ts.
//
// Note that the front end caches stuff locally, so even if the back-end isn't
// available for whatever reason, clients shouldn't notice (apart from stuff
// being missing and/or not persisted).
//
// The Cache client follows a similar ethos to other model-like modules
// (e.g. stored-object and model) wherein it provides a get() method for
// retrieving a plain old JS object which is updated auto-magically when the
// contents of the cache change.  This is so Vue can do the right thing in
// showing cache entries to the end user.
//
// The cache is modified using set(), which sends the change to the cache
// service (and eventually on to all other clients).
//
// There are NO guarantees about consistency/atomicity of updates.  It is
// possible the cache may report stale data if multiple updates occur/are
// broadcast in quick succession; if this is a concern (and it's REALLY worth
// the extra complexity), code changes are required. :)

import {CacheContent, Message} from './cache-proto';

// Ugly global object which keeps track of all the open caches, so we only have
// one client per cache per JS environment.
const CACHES = new Map<string, Cache<any>>();

// A cache entry, exposed to the consumer thru Cache.get().
export type CacheEntry<Content extends CacheContent> = {
    key: string,
    value: Content | undefined,
    requested: boolean,
};

// The cache.
export class Cache<Content extends CacheContent> {
    private _local_cache: Map<string, CacheEntry<Content>> = new Map();

    private _name: string;
    private _service: browser.runtime.Port;

    static open<Content extends CacheContent>(name: string): Cache<Content> {
        let cache = CACHES.get(name);
        if (cache) {
            return cache;
        } else {
            cache = new Cache(
                name,
                browser.runtime.connect(undefined, {name: `cache:${name}`})
            );
        }

        CACHES.set(name, cache);

        return cache;
    }

    // DON'T call this directly -- use open() instead.
    constructor(name: string, conn: browser.runtime.Port) {
        this._name = name;
        this._service = conn;

        this._service.onDisconnect.addListener(port => {
            console.log(`cache:${this._name}: Lost connection to service`);
        });

        this._service.onMessage.addListener(msg => {
            const m = msg as Message<Content>;
            switch (m.type) {
                case 'entry': {
                    const ent = this._local_cache.get(m.key);
                    if (ent) ent.value = m.value;
                    break;
                }

                case 'expiring': {
                    const ent = this._local_cache.get(m.key);
                    if (ent) ent.value = undefined;
                    // We never delete stuff from _local_cache because it might
                    // mean Vue doesn't receive updates for things that are
                    // dropped and later re-added to the cache :/
                    break;
                }

                case 'fetch': // should never be received from service
                default:
                    // Perhaps we are speaking different protocol versions;
                    // ignore unknown messages.
                    console.warn(`cache:${this._name}: Received unknown message: ${JSON.stringify(m)}`);
            }
        });
    }

    get(key: string): CacheEntry<Content> {
        const ent = this._cached(key);
        if (! ent.requested) {
            this._send({type: 'fetch', key});
            ent.requested = true;
        }
        return ent;
    }

    set(key: string, value: Content): CacheEntry<Content> {
        const ent = this._cached(key);
        ent.value = value;
        this._send({type: 'entry', key, value});
        return ent;
    }

    // Implementation details past this point.

    _cached(key: string): CacheEntry<Content> {
        let ent = this._local_cache.get(key);
        if (! ent) {
            ent = {key, value: undefined, requested: false};
            this._local_cache.set(key, ent);
        }
        return ent;
    }

    _send(m: Message<Content>) {
        this._service.postMessage(m);
    }
}