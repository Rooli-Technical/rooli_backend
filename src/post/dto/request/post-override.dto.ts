import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class PostOverrideDto {
  @ApiProperty({
    example: 'profile_twitter_123',
    description: 'Social profile ID this override applies to',
  })
  @IsNotEmpty()
  @IsString()
  socialProfileId: string;

  @ApiProperty({
    example: 'Launching today 🚀 #startup #buildinpublic',
    description: 'Customized content for the specific social profile',
  })
  @IsNotEmpty()
  @IsString()
  content: string;
}
