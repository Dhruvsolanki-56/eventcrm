import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export default function CaptureChart({ data }: { data: Array<{ day: string; captures: number }> }) {
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 10, bottom: 2, left: -22 }}>
    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e8e4dc" />
    <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={1} />
    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
    <Tooltip />
    <Bar dataKey="captures" name="People captured" fill="#739886" maxBarSize={30} radius={[3,3,0,0]} />
  </BarChart></ResponsiveContainer>;
}
