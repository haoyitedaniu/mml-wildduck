'use strict';

const ObjectID = require('mongodb').ObjectID;
const fingerprint = require('key-fingerprint').fingerprint;
const crypto = require('crypto');
const tls = require('tls');
const forge = require('node-forge');
const tools = require('./tools');
const log = require('npmlog');
const tlsOptions = require('../imap-core/lib/tls-options');
const { publish, CERT_CREATED, CERT_UPDATED, CERT_DELETED } = require('./events');

const { promisify } = require('util');
const generateKeyPair = promisify(crypto.generateKeyPair);

const CERT_RENEW_TTL = 30 * 24 * 3600 * 1000;
const CERT_RENEW_DELAY = 24 * 3600 * 100;

class CertHandler {
    constructor(options) {
        options = options || {};
        this.cipher = options.cipher;
        this.secret = options.secret;

        this.database = options.database;
        this.redis = options.redis;

        this.ctxCache = new Map();

        this.loggelf = options.loggelf || (() => false);
    }

    getAltNames(parsedCert) {
        let response = [];
        let altNames = parsedCert.extensions && parsedCert.extensions.find(ext => ext.id === '2.5.29.17');
        let subject = parsedCert.subject && parsedCert.subject.attributes && parsedCert.subject.attributes.find(attr => attr.type === '2.5.4.3');

        if (altNames && altNames.altNames && altNames.altNames.length) {
            response = altNames.altNames.map(an => an.value).filter(value => value);
        }

        if (!response.length && subject && subject.value) {
            response.push(subject.value);
        }

        response = response.map(name => tools.normalizeDomain(name));

        return response;
    }

    async generateKey(keyBits, keyExponent) {
        const { privateKey /*, publicKey */ } = await generateKeyPair('rsa', {
            modulusLength: keyBits || 2048, // options
            publicExponent: keyExponent || 65537,
            publicKeyEncoding: {
                type: 'pkcs1',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs1',
                format: 'pem'
            }
        });

        return privateKey;
    }

    getCertName(parsedCert) {
        let subject = parsedCert.subject && parsedCert.subject.attributes && parsedCert.subject.attributes.find(attr => attr.type === '2.5.4.3');
        if (subject && subject.value) {
            return tools.normalizeDomain(subject.value);
        }

        let altNames = parsedCert.extensions && parsedCert.extensions.find(ext => ext.id === '2.5.29.17');
        if (altNames && altNames.altNames && altNames.altNames.length) {
            let list = altNames.altNames.map(an => an.value && tools.normalizeDomain(an.value)).filter(value => value);
            return list[0];
        }
        return '';
    }

    prepareQuery(options) {
        let query = {};
        options = options || {};

        if (options.servername) {
            query.servername = tools.normalizeDomain(options.servername);
        } else if (options._id && tools.isId(options._id)) {
            query._id = new ObjectID(options._id);
        } else {
            let err = new Error('Invalid or unknown cert');
            err.responseCode = 404;
            err.code = 'CertNotFound';
            throw err;
        }

        return query;
    }

    async getNextRenewal() {
        let r = await this.database.collection('certs').findOneAndUpdate(
            {
                acme: true,
                expires: {
                    $lt: new Date(Date.now() + CERT_RENEW_TTL)
                },
                $or: [
                    { '_acme.lastRenewalCheck': { $exists: false } },
                    {
                        '_acme.lastRenewalCheck': {
                            $lt: new Date(Date.now() - CERT_RENEW_DELAY)
                        }
                    }
                ]
            },
            { $set: { '_acme.lastRenewalCheck': new Date() } },
            {
                upsert: false,
                returnDocument: 'after'
            }
        );
        return (r && r.value) || false;
    }

    async update(options, updates, updateOptions) {
        updateOptions = updateOptions || {};
        let query = this.prepareQuery(options);

        let r;

        if (!updates || typeof updates !== 'object' || !Object.keys(updates).length) {
            // nothing to do here
            return false;
        }

        const changes = {
            $set: updates
        };

        let fp;
        if (updates.privateKey) {
            try {
                fp = fingerprint(updates.privateKey, 'sha256', true);
            } catch (E) {
                let err = new Error('Invalid or incompatible private key. ' + E.message);
                err.responseCode = 400;
                err.code = 'InputValidationError';
                throw err;
            }

            let encodedPrivateKey = await this.encodeKey(updates.privateKey);

            changes.$set = Object.assign({}, updates, { fp, privateKey: encodedPrivateKey });

            changes.$inc = { v: 1 };
        }

        if (updateOptions.certUpdated) {
            changes.$set['_acme.lastError'] = null;
        }

        try {
            r = await this.database.collection('certs').findOneAndUpdate(query, changes, {
                upsert: false,
                returnDocument: 'after'
            });
        } catch (err) {
            if (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }
        }

        if (!r.value) {
            let err = new Error('Failed to update Cert data');
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (this.redis && updates.cert) {
            try {
                await publish(this.redis, {
                    ev: CERT_UPDATED,
                    cert: r.value._id.toString(),
                    servername: r.value.servername,
                    fingerprint: r.value.fp
                });
            } catch (err) {
                // ignore?
            }
        }

        return true;
    }

    async resetPrivateKey(options, acme) {
        let query = this.prepareQuery(options);

        let privateKey = await this.generateKey(acme.keyBits, acme.keyExponent);

        let fp;
        try {
            fp = fingerprint(privateKey, 'sha256', true);
        } catch (E) {
            let err = new Error('Invalid or incompatible private key. ' + E.message);
            err.responseCode = 400;
            err.code = 'InputValidationError';
            throw err;
        }

        let encodedPrivateKey = await this.encodeKey(privateKey);

        let r;
        try {
            r = await this.database.collection('certs').findOneAndUpdate(
                query,
                {
                    $set: {
                        fp,
                        privateKey: encodedPrivateKey,
                        updated: new Date()
                    },
                    $inc: { v: 1 }
                },
                {
                    upsert: false,
                    returnDocument: 'after'
                }
            );
        } catch (err) {
            if (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }
        }

        if (!r.value) {
            let err = new Error('Failed to insert Cert key');
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        return privateKey;
    }

    async set(options) {
        // if not set then resolve from certificate
        let servername = options.servername && tools.normalizeDomain(options.servername);

        const description = options.description;

        let privateKey = options.privateKey;
        let cert = options.cert;
        let ca = options.ca;
        let primaryCert;

        let certData = {
            updated: new Date(),
            acme: !!options.acme
        };

        if (privateKey) {
            try {
                certData.fingerprint = fingerprint(privateKey, 'sha256', true);
            } catch (E) {
                let err = new Error('Invalid or incompatible private key. ' + E.message);
                err.responseCode = 400;
                err.code = 'InputValidationError';
                throw err;
            }

            certData.privateKey = await this.encodeKey(privateKey);
        }

        if (cert) {
            primaryCert = cert;
            let certEnd = primaryCert.match(/END CERTIFICATE-+/);
            if (certEnd) {
                primaryCert = primaryCert.substr(0, certEnd.index + certEnd[0].length);
            }
            certData.cert = cert;
        }

        certData.ca = [].concat(ca || []);

        if (primaryCert) {
            try {
                const parsedCert = forge.pki.certificateFromPem(primaryCert);

                certData.expires = new Date(parsedCert.validity.notAfter.toISOString());
                certData.altNames = this.getAltNames(parsedCert);

                if (!servername) {
                    servername = this.getCertName(parsedCert);
                }
            } catch (err) {
                log.error('Certs', 'Failed to parse certificate. error=%s', err.message);
            }
        }

        if (!servername) {
            let err = new Error('Invalid or missing servername');
            err.responseCode = 400;
            err.code = 'InputValidationError';
            throw err;
        }

        if (!certData.altNames || !certData.altNames.length) {
            certData.altNames = [servername];
        }

        if (description) {
            certData.description = description;
        }

        if (privateKey && cert) {
            try {
                // should fail on invalid input
                tls.createSecureContext({
                    key: privateKey,
                    cert,
                    ca
                });
            } catch (E) {
                let err = new Error('Invalid or incompatible key and certificate. ' + E.message);
                err.responseCode = 400;
                err.code = 'InputValidationError';
                throw err;
            }
        }

        let r;
        try {
            r = await this.database.collection('certs').findOneAndUpdate(
                {
                    servername
                },
                { $set: certData, $inc: { v: 1 }, $setOnInsert: { servername, created: new Date() } },
                {
                    upsert: true,
                    returnDocument: 'after'
                }
            );
        } catch (err) {
            if (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }
        }

        if (!r.value) {
            let err = new Error('Failed to insert Cert key');
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (this.redis && certData.cert) {
            try {
                if (r.lastErrorObject.upserted) {
                    await publish(this.redis, {
                        ev: CERT_CREATED,
                        cert: r.value._id.toString(),
                        servername,
                        fingerprint: certData.fingerprint
                    });
                } else if (r.lastErrorObject.updatedExisting) {
                    await publish(this.redis, {
                        ev: CERT_UPDATED,
                        cert: r.value._id.toString(),
                        servername,
                        fingerprint: certData.fingerprint
                    });
                }
            } catch (err) {
                // ignore?
            }
        }

        return {
            id: r.value._id.toString(),
            servername,
            description: certData.description,
            fingerprint: certData.fingerprint,
            expires: certData.expires && certData.expires.toISOString(),
            altNames: certData.altNames,
            acme: certData.acme
        };
    }

    async get(options, includePrivateKey) {
        let certData = await this.getRecord(options, includePrivateKey);

        let res = {
            id: certData._id.toString(),
            servername: certData.servername,
            description: certData.description,
            fingerprint: certData.fingerprint,
            expires: certData.expires,
            altNames: certData.altNames,
            acme: !!certData.acme,
            created: certData.created
        };

        if (includePrivateKey && certData.privateKey) {
            res.privateKey = certData.privateKey;
        }

        return res;
    }

    async getRecord(options, includePrivateKey) {
        let query = this.prepareQuery(options);

        let certData;
        try {
            certData = await this.database.collection('certs').findOne(query);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!certData) {
            let err = new Error('Invalid or unknown cert');
            err.responseCode = 404;
            err.code = 'CertNotFound';
            throw err;
        }

        if (includePrivateKey) {
            certData.privateKey = await this.decodeKey(certData.privateKey);
        } else {
            delete certData.privateKey;
        }

        return certData;
    }

    async encodeKey(privateKey) {
        if (!privateKey) {
            return null;
        }

        if (this.secret) {
            try {
                let cipher = crypto.createCipher(this.cipher || 'aes192', this.secret);
                privateKey = '$' + cipher.update(privateKey, 'utf8', 'hex');
                privateKey += cipher.final('hex');
            } catch (E) {
                let err = new Error('Failed to encrypt private key. ' + E.message);
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }
        }

        return privateKey;
    }

    async decodeKey(privateKey) {
        if (!privateKey) {
            return null;
        }

        if (privateKey.charAt(0) === '$') {
            if (this.secret) {
                try {
                    let decipher = crypto.createDecipher(this.cipher || 'aes192', this.secret);
                    privateKey = decipher.update(privateKey.substr(1), 'hex', 'utf-8');
                    privateKey += decipher.final('utf8');
                } catch (E) {
                    let err = new Error('Failed to decrypt private key. ' + E.message);
                    err.responseCode = 500;
                    err.code = 'InternalConfigError';
                    throw err;
                }
            } else {
                let err = new Error('Can not use decrypted key');
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }
        }

        return privateKey;
    }

    async del(options) {
        let query = this.prepareQuery(options);

        // delete cert key from database
        let r;
        try {
            r = await this.database.collection('certs').findOneAndDelete(query);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!r.value) {
            let err = new Error('Invalid or unknown cert');
            err.responseCode = 404;
            err.code = 'CertNotFound';
            throw err;
        }

        try {
            await publish(this.redis, {
                ev: CERT_DELETED,
                cert: r.value._id,
                servername: r.value.servername,
                fingerprint: r.value.fingerprint
            });
        } catch (err) {
            // ignore?
        }

        return true;
    }

    async getContextForServername(servername, serverOptions) {
        let query = { servername };

        let cachedContext = false;
        if (this.ctxCache.has(servername)) {
            cachedContext = this.ctxCache.get(servername);
            if (cachedContext.entry && cachedContext.entry.v) {
                // check for updates
                query.v = { $ne: cachedContext.entry.v };
            }
        }

        // search for exact servername match at first
        let certData = await this.database.collection('certs').findOne(query);
        if (!certData || !certData.privateKey || !certData.cert) {
            if (cachedContext && cachedContext.context && cachedContext.entry && cachedContext.entry.servername === servername) {
                // we have a valid cached context
                return cachedContext.context;
            }

            // try altNames as well
            const altQuery = {
                $or: [{ altNames: servername }]
            };

            if (servername.indexOf('.') >= 0) {
                let wcMatch = '*' + servername.substr(servername.indexOf('.'));
                altQuery.$or.push({ altNames: wcMatch });
            }

            if (query.v) {
                altQuery.v = query.v;
            }

            certData = await this.database.collection('certs').findOne(altQuery, { sort: { expires: -1 } });
            if (!certData || !certData.privateKey || !certData.cert) {
                // still nothing, return whatever we have
                return (cachedContext && cachedContext.context) || false;
            }
        }

        // key might be encrypted
        let privateKey = await this.decodeKey(certData.privateKey);

        let serviceCtxOpts = { key: privateKey, cert: certData.cert, ca: certData.ca };
        for (let key of ['dhparam']) {
            if (serverOptions[key]) {
                serviceCtxOpts[key] = serverOptions[key];
            }
        }

        let ctxOptions = tlsOptions(serviceCtxOpts);

        let context = tls.createSecureContext(ctxOptions);

        this.ctxCache.set(servername, { entry: certData, context });

        return context;
    }
}

module.exports = CertHandler;
