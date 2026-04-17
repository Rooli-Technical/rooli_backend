import { IsEmail, IsString, IsNumber, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ContactEnterpriseDto {
  @ApiProperty({ example: 'Acme Corp', description: 'Name of the company' })
  @IsString()
  @IsNotEmpty()
  companyName: string;

  @ApiProperty({ example: 'founder@acmecorp.com', description: 'Contact email' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '50-200', description: 'Number of employees' })
  @IsString()
  @IsNotEmpty()
  companySize: string;

  @ApiProperty({ example: 25, description: 'Estimated number of social profiles needed' })
  @IsNumber()
  socialProfiles: number;

  @ApiProperty({ example: 5, description: 'Estimated number of workspaces needed' })
  @IsNumber()
  workspaces: number;

  @ApiProperty({ 
    example: 'We need custom SSO, white-labeling, and dedicated account management.',
    description: 'What they want to achieve with the Enterprise plan' 
  })
  @IsString()
  @IsNotEmpty()
  primaryGoals: string;
}