import { Verifier } from "./verifier"
import{ expect } from "chai"

describe('Verifier', () => {
    it('should verify a released version of tbv', async () => {
        const verifier = new Verifier()

        const verification = await verifier.verify("tbv@0.3.6")

        expect(verification).to.be.true;
    }).timeout(15000)
})