var expect = require('chai').expect;
var request = require('supertest');
var expressx = require('expressx');
var bootable = require('bootable');
var middleware = require('../');

describe('middleware', function () {
    it('configures middleware (end-to-end)', function (done) {
        var owner = {
            app: expressx()
        };
        var initializer = new bootable.Initializer();
        initializer.phase(middleware(__dirname));
        initializer.run(function (err) {
            if (err) done(err);
        }, owner);

        request(owner.app)
            .get('/')
            .end(function(err, res) {
                if (err && err.status !== 404) return done(err);
                expect(res.headers.names).to.equal('custom-middleware');
                done();
            });
    });
});
