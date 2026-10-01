import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export default function ReportChart({ data }: { data: Array<{ stage: string; people: number }> }) {
  return <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 10, bottom: 2, left: -22 }}><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#e8ede8" /><XAxis dataKey="stage" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#7b887e' }} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#7b887e' }} /><Tooltip /><Bar dataKey="people" fill="#739886" maxBarSize={34} radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>;
}
