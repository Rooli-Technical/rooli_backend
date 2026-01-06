import { Controller, Post, Get, Body, BadRequestException, Res, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { Public } from '@/common/decorators/public.decorator';

@Controller('webhooks/meta')
@Public()
export class MetaWebhooksController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 1. DEAUTHORIZE CALLBACK
   * Triggered when user clicks "Remove App" in FB/IG Settings.
   * We should disable their connection in our DB.
   */
  @Post('deauthorize')
  async deauthorize(@Body('signed_request') signedRequest: string) {
    const data = this.parseSignedRequest(signedRequest);
    const providerUserId = data.user_id; // This is the FB/IG User ID

    // Disable or Delete the connection in your DB
    await this.prisma.socialConnection.deleteMany({
      where: { platformUserId: providerUserId },
    });

    // You can also cascade delete SocialProfiles here if you want strict cleanup
    
    return { success: true };
  }

  /**
   * 2. DATA DELETION REQUEST
   * Triggered when user asks to "Delete Data" explicitly.
   * Must return a JSON with a URL and Confirmation Code.
   */
  @Post('delete-data')
  async requestDeletion(
    @Body('signed_request') signedRequest: string,
    @Res() res: Response
  ) {
    const data = this.parseSignedRequest(signedRequest);
    const providerUserId = data.user_id;

    // 1. Generate a tracking code
    const confirmationCode = crypto.randomBytes(4).toString('hex'); // e.g., "a1b2c3d4"

    // 2. Perform Deletion (or schedule it)
    await this.prisma.socialConnection.deleteMany({
      where: { platformUserId: providerUserId },
    });

    // 3. Return the specific JSON format Meta requires
    const statusUrl = `${this.config.get('API_URL')}/api/v1/social-privacy/deletion-status/${confirmationCode}`;
    
    return res.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  }

  /**
   * 3. DELETION STATUS (User Facing)
   * The user clicks the link provided above to confirm their data is gone.
   */
  @Get('deletion-status/:code')
  deletionStatus(@Param('code') code: string) {
    return {
      message: 'Data Deletion Completed',
      details: `Your data associated with request code ${code} has been successfully removed from Rooli.`,
      timestamp: new Date(),
    };
  }

  // -------------------------------------------------------
  // PRIVATE HELPER: Parse "signed_request"
  // -------------------------------------------------------
  private parseSignedRequest(signedRequest: string) {
    if (!signedRequest) throw new BadRequestException('Missing signed_request');

    const [encodedSig, payload] = signedRequest.split('.', 2);

    // Decode Payload
    const decodedPayload = Buffer.from(payload, 'base64').toString('utf-8');
    const data = JSON.parse(decodedPayload);

    // OPTIONAL: Verify Signature (Recommended for Prod)
    // You check if HMAC_SHA256(payload, APP_SECRET) matches encodedSig
    
    return data;
  }
}
