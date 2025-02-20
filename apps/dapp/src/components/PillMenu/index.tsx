import { FC } from 'react';
import { Link as BaseLink, useResolvedPath, useMatch } from 'react-router-dom';
import styled from 'styled-components';

interface LinkProps {
  to: string;
  label: string;
}

interface Props {
  links: LinkProps[];
}

export const PillMenu = ({ links }: Props) => {
  return (
    <MenuWrapper>
      <Menu>
        {links.map(({ to, label }) => (
          <MenuLink to={to} key={to}>{label}</MenuLink>
        ))}
      </Menu>
    </MenuWrapper>
  );
};

const MenuLink: FC<{ to: string }> = (props) => {
  const resolved = useResolvedPath(props.to);
  const match = useMatch({ path: resolved.pathname, end: true });
  return (
    <Link {...props} $isActive={!!match} />
  );
};

const MenuWrapper = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 100%;
  justify-content: space-between;
`;

const Menu = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
`;

const Link = styled(BaseLink)<{ $isActive: boolean }>`
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  display: block;
  background: ${({ $isActive }) => $isActive ? '#1D1A1A' : 'transparent'};
  transition: all ease-out 200ms;
`;
