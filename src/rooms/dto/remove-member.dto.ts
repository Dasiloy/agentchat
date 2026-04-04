import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RemoveMemberDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email: string;
}
