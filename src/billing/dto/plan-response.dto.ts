export class PlanDto {
  id: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  features: Record<string, any>; 
  
  constructor(partial: Partial<PlanDto>) {
    Object.assign(this, partial);
  }
}